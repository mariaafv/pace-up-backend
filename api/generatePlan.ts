import { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// --- INICIALIZAÇÃO FIREBASE ADMIN ---
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY as string);
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
} catch (e) {
  console.error('Firebase Admin Initialization Error:', e);
}

// --- INICIALIZAÇÃO SUPABASE ---
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// --- AUX: Gera todos os dias do mês em pt-BR ---
function generateMonthDays(): string[] {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth();

  const startDate = new Date(year, month, 1);
  const endDate = new Date(year, month + 1, 0);

  const formatter = new Intl.DateTimeFormat('pt-BR', { weekday: 'long' });
  const days: string[] = [];

  for (let d = startDate.getDate(); d <= endDate.getDate(); d++) {
    const date = new Date(year, month, d);
    const dayName = formatter.format(date);
    days.push(dayName.charAt(0).toUpperCase() + dayName.slice(1));
  }
  return days;
}

// --- HANDLER ---
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Método não permitido.' });
  }

  let userId: string | undefined;
  let aiResponse: string | undefined;

  try {
    // 1️⃣ Verifica token Firebase
    const firebaseToken = request.headers.authorization?.split('Bearer ')[1];
    if (!firebaseToken) return response.status(401).json({ error: 'Nenhum token fornecido.' });

    const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    userId = decodedToken.uid;

    const { profileData } = request.body;
    if (!profileData) return response.status(400).json({ error: 'profileData é obrigatório.' });

    // 2️⃣ Gera dias do mês
    const monthDays = generateMonthDays();

    // 3️⃣ Prompt aprimorado para IA
    const prompt = `
Você é um coach de corrida especialista em IA chamado PaceUp.
Um novo usuário se cadastrou com o seguinte perfil:
- Experiência: ${profileData.experience}
- Objetivo Final: ${profileData.goal}
- Peso: ${profileData.weight || "não informado"} kg
- Altura: ${profileData.height || "não informado"} cm
- Dias disponíveis para correr: ${profileData.run_days.join(", ")}

Crie um plano completo de treino para **TODO O MÊS**, dividido em 4 semanas (week1 a week4).
Para cada dia:
- "day": Nome do dia da semana em pt-BR
- "type": Tipo do treino (Ex: Caminhada, Corrida leve, Intervalado, Descanso, Descanso ativo)
- "duration_minutes": número inteiro em minutos
- "description": dicas de respiração, postura e motivação.

Retorne apenas JSON válido, começando com '{' e terminando com '}'.
Formato:
{
  "week1": [...],
  "week2": [...],
  "week3": [...],
  "week4": [...]
}
`;

    // 4️⃣ Inicializa o cliente Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);

    const model = genAI.getGenerativeModel({ model: "gemini-1.5-pro" });

    // 5️⃣ Gera o plano
    const result = await model.generateContent(prompt);
    aiResponse = result.response.text();
    if (!aiResponse) throw new Error("A IA não retornou conteúdo.");

    // 6️⃣ Extrai JSON
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Nenhum JSON válido encontrado na resposta da IA.");

    const workoutPlanJson = JSON.parse(jsonMatch[0]);

    // 7️⃣ Salva no Supabase
    const finalUserData = {
      id: userId,
      ...profileData,
      workout_plan: workoutPlanJson,
      planGenerationError: null,
      rawAIResponse: null,
    };

    const { error } = await supabaseAdmin.from('profiles').upsert(finalUserData);
    if (error) throw error;

    console.log(`✅ Plano gerado com sucesso para o usuário ${userId}`);
    return response.status(200).json({
      success: true,
      message: 'Plano gerado com sucesso!',
      workout_plan: workoutPlanJson
    });

  } catch (error: any) {
    console.error("❌ Erro na Vercel Function:", error.message);

    if (userId) {
      await supabaseAdmin.from('profiles').upsert({
        id: userId,
        planGenerationError: error.message,
        rawAIResponse: aiResponse || "Nenhuma resposta recebida da IA."
      });
    }

    return response.status(500).json({ error: error.message });
  }
}

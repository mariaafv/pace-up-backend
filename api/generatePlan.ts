import { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// --- FIREBASE ADMIN ---
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

// --- SUPABASE ---
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// --- UTILS ---
interface WorkoutDay {
  day: string;
  type: string;
  duration_minutes: number;
  description: string;
}

interface WorkoutPlan {
  week1: WorkoutDay[];
  week2: WorkoutDay[];
  week3: WorkoutDay[];
  week4: WorkoutDay[];
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

    // 2️⃣ Prompt para Gemini
    const prompt = `
Você é um coach de corrida especialista em IA chamado PaceUp.
Novo usuário:
- Experiência: ${profileData.experience}
- Objetivo: ${profileData.goal}
- Peso: ${profileData.weight || "não informado"} kg
- Altura: ${profileData.height || "não informado"} cm
- Dias disponíveis: ${profileData.run_days.join(", ")}

Crie **plano de corrida completo para 4 semanas** (week1 a week4).
Cada dia deve conter:
- "day": Nome do dia da semana em pt-BR
- "type": Tipo do treino (Caminhada, Corrida leve, Intervalado, Descanso, Descanso ativo)
- "duration_minutes": inteiro em minutos
- "description": dicas de respiração, postura e motivação

Retorne APENAS o JSON:
{
  "week1": [ {...} ],
  "week2": [ {...} ],
  "week3": [ {...} ],
  "week4": [ {...} ]
}
`;

    // 3️⃣ Inicializa Gemini
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

    // 4️⃣ Gera o plano
    const result = await model.generateContent(prompt);
    aiResponse = result.response.text();
    if (!aiResponse) throw new Error("A IA não retornou conteúdo.");

    // 5️⃣ Extrai JSON
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Nenhum JSON válido encontrado na resposta da IA.");

    const workoutPlanRaw: WorkoutPlan = JSON.parse(jsonMatch[0]);

    // --- VALIDAÇÃO SIMPLES ---
    ['week1', 'week2', 'week3', 'week4'].forEach(week => {
      if (!workoutPlanRaw[week as keyof WorkoutPlan]) {
        workoutPlanRaw[week as keyof WorkoutPlan] = [];
      }
    });

    // 6️⃣ Salva no Supabase
    const finalUserData = {
      id: userId,
      ...profileData,
      workout_plan: workoutPlanRaw,
      planGenerationError: null,
      rawAIResponse: null,
    };

    const { error } = await supabaseAdmin.from('profiles').upsert(finalUserData);
    if (error) throw error;

    console.log(`✅ Plano gerado com sucesso para o usuário ${userId}`);
    return response.status(200).json({
      success: true,
      message: "Plano gerado com sucesso!",
      workout_plan: workoutPlanRaw,
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

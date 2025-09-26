import { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
import { VertexAI } from '@google-cloud/vertexai';
// MUDANÇA 1: Importa a GoogleAuth
import { GoogleAuth } from 'google-auth-library';

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

// --- INICIALIZAÇÃO SUPABASE ADMIN ---
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// --- MUDANÇA 2: Inicialização da Autenticação e do Cliente Vertex AI ---
const auth = new GoogleAuth({
  credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY as string),
});

const vertex_ai = new VertexAI({
  project: process.env.GOOGLE_PROJECT_ID as string,
  location: 'us-central1',
  googleAuthOptions: {
    credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY as string),
  },
});
// --- HANDLER PRINCIPAL ---
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Método não permitido.' });
  }

  let userId: string | undefined;
  let aiResponseText: string | undefined;

  try {
    const firebaseToken = request.headers.authorization?.split('Bearer ')[1];
    if (!firebaseToken) return response.status(401).json({ error: 'Nenhum token fornecido.' });

    const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    userId = decodedToken.uid;

    const { profileData } = request.body;
    if (!profileData) return response.status(400).json({ error: 'profileData é obrigatório.' });

const prompt = `
Você é um coach de corrida especialista em IA chamado PaceUp.
Um novo usuário se cadastrou com o seguinte perfil:
- Experiência: ${profileData.experience}
- Objetivo Final: ${profileData.goal}
- Peso: ${profileData.weight || "não informado"} kg
- Altura: ${profileData.height || "não informado"} cm
- Dias disponíveis para correr: ${profileData.run_days.join(", ")}

Sua tarefa é criar um plano completo de treino para **TODO O MÊS**, dividido em 4 semanas (week1 a week4), usando os dias da semana corretos.
Para cada dia:
- Se for dia de treino, varie entre caminhada, corrida leve, corrida moderada, HIIT leve.
- Inclua alongamento inicial e final.
- Ajuste a intensidade e duração conforme o nível de experiência do usuário.
- Se for dia de descanso, indique se será descanso ativo (ex: caminhada leve ou ioga) ou completo.
- Adicione notas motivacionais e dicas de postura.
- Use o seguinte formato JSON estrito (não inclua texto fora do JSON):
{
"week1": [{"day": "Segunda", "type": "Corrida leve", "duration_minutes": 20, "description": "Descrição detalhada"}],
"week2": [...],
"week3": [...],
"week4": [...]
}

Comece com '{' e termine com '}'.
`;

    // MUDANÇA: Usa o cliente VertexAI e um nome de modelo estável
    const model = vertex_ai.getGenerativeModel({
        model: "gemini-1.5-pro-preview-0409", 
    });

    const result = await model.generateContent(prompt);
    aiResponseText = result.response.candidates?.[0].content.parts[0].text;
    
    if (!aiResponseText) throw new Error("A IA não retornou conteúdo.");

    const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Nenhum JSON válido encontrado na resposta da IA.");
    const workoutPlanJson = JSON.parse(jsonMatch[0]);

    // O resto da lógica para salvar no Supabase continua a mesma
    const finalUserData = { id: userId, ...profileData, workout_plan: workoutPlanJson };
    const { error } = await supabaseAdmin.from('profiles').upsert(finalUserData);
    if (error) throw error;

    return response.status(200).json({ success: true, message: 'Plano gerado com sucesso!' });

  } catch (error: any) {
    console.error("Erro na Vercel Function:", error.message);
    if (userId) {
      await supabaseAdmin.from('profiles').upsert({
        id: userId,
        planGenerationError: error.message,
        rawAIResponse: aiResponseText || "Nenhuma resposta recebida da IA."
      });
    }
    return response.status(500).json({ error: error.message });
  }
}
import { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
import { VertexAI } from '@google-cloud/vertexai';
import { GoogleAuth } from 'google-auth-library';

// --- INITIALIZATIONS ---
// The Firebase Admin SDK is initialized once with the service account key.
// This is the only place credentials need to be handled.
try {
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY as string)),
    });
    console.log('Firebase Admin Initialized Successfully.');
  }
} catch (e) {
  console.error('Firebase Admin Initialization Error:', e);
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// The VertexAI client will automatically find the credentials from firebase-admin
// when running in a cloud environment.
const vertex_ai = new VertexAI({
  project: process.env.GOOGLE_PROJECT_ID as string,
  location: 'us-central1',
});

// --- HANDLER PRINCIPAL ---
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Método não permitido.' });
  }

  let userId: string | undefined;
  let aiResponseText: string | undefined;

  try {
    // PASSO 1 DA DEPURAÇÃO: Descobrir a conta de serviço
    const auth = new GoogleAuth({
      credentials: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY as string),
    });
    const credentials = await auth.getCredentials();
    console.log(`INFO: Usando a conta de serviço: ${credentials.client_email}`);

    const vertex_ai = new VertexAI({
      project: process.env.GOOGLE_PROJECT_ID as string,
      location: 'us-central1',
    });
    
    // --- Lógica da Função ---
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
      - Dias disponíveis para correr: ${profileData.run_days.join(", ")}

      Crie um plano completo de treino para 4 semanas.
      Retorne apenas JSON válido.
      Formato:
      {
        "week1": [{"day": "Segunda", "type": "Corrida leve", "duration_minutes": 20, "description": "Descrição detalhada"}],
        "week2": [...], "week3": [...], "week4": [...]
      }
    `;

    // PASSO 2 DA DEPURAÇÃO: Usar um modelo mais estável
    const model = vertex_ai.getGenerativeModel({
        model: "gemini-1.0-pro", 
    });

    const result = await model.generateContent(prompt);
    aiResponseText = result.response.candidates?.[0].content.parts[0].text;
    
    if (!aiResponseText) throw new Error("A IA não retornou conteúdo.");

    const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Nenhum JSON válido encontrado na resposta da IA.");
    const workoutPlanJson = JSON.parse(jsonMatch[0]);

    const finalUserData = { id: userId, ...profileData, workout_plan: workoutPlanJson };
    const { error } = await supabaseAdmin.from('profiles').upsert(finalUserData);
    if (error) throw error;

    console.log(`✅ Plano gerado com sucesso para o usuário ${userId}`);
    return response.status(200).json({ success: true, message: 'Plano gerado com sucesso!' });

  } catch (error: any) {
    console.error("❌ Erro na Vercel Function:", error.message);
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
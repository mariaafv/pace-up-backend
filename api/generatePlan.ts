import { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// --- INICIALIZAÇÃO (continua a mesma) ---
try {
  const serviceAccount = JSON.parse(
    process.env.FIREBASE_SERVICE_ACCOUNT_KEY as string
  );
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  }
} catch (e) {
  console.error('Firebase Admin Initialization Error:', e);
}

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);
// --- FIM DA INICIALIZAÇÃO ---

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Método não permitido.' });
  }

  try {
    const firebaseToken = request.headers.authorization?.split('Bearer ')[1];
    if (!firebaseToken) {
      return response.status(401).json({ error: 'Nenhum token fornecido.' });
    }

    const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    const userId = decodedToken.uid;
    
    const { profileData } = request.body;
    if (!profileData) {
      return response.status(400).json({ error: 'profileData é obrigatório.' });
    }
    
    // --- LÓGICA DA IA (continua a mesma) ---
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
    const prompt = `Gere um plano de treino para um usuário com os seguintes dados: ${JSON.stringify(profileData)}. Retorne apenas o JSON do plano.`;
    const result = await model.generateContent(prompt);
    const aiResponse = result.response.text();
    const cleanedText = aiResponse.replace(/```json/g, "").replace(/```/g, "").trim();
    const workoutPlanJson = JSON.parse(cleanedText);
    
    // --- LÓGICA DE SALVAMENTO (A PARTE CORRIGIDA) --- //

    // 1. Combina os dados do perfil e o plano de treino em um único objeto
    const finalUserData = {
      id: userId, // Garante que o ID está no objeto a ser salvo
      ...profileData,
      workout_plan: workoutPlanJson
    };

    // 2. Usa o método '.upsert()'
    // Ele vai inserir um novo usuário ou atualizar um existente.
    const { error } = await supabaseAdmin
      .from('profiles')
      .upsert(finalUserData); // <-- MUDANÇA PRINCIPAL AQUI

    if (error) throw error; // Se houver erro, ele será capturado pelo catch

    return response.status(200).json({ success: true, message: 'Plano gerado com sucesso!' });

  } catch (error: any) {
    console.error("Erro na Vercel Function:", error);
    return response.status(500).json({ error: error.message });
  }
}
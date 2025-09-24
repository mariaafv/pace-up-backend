import { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import { GoogleGenerativeAI } from '@google/generative-ai';

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
  console.error('Firebase Admin Initialization Error', e);
}

const firestore = admin.firestore();

export default async function handler(
  request: VercelRequest,
  response: VercelResponse,
) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Método não permitido.' });
  }

  const { userId, profileData } = request.body;
  if (!userId || !profileData) {
    return response.status(400).json({ error: 'userId e profileData são obrigatórios.' });
  }

  try {
    await firestore.collection('users').doc(userId).set(profileData, { merge: true });
    console.log(`Perfil para ${userId} salvo com sucesso.`);

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });
    const prompt = `Gere um plano de treino para um usuário com os seguintes dados: ${JSON.stringify(profileData)}. Retorne apenas o JSON do plano.`;

    const result = await model.generateContent(prompt);
    const aiResponse = result.response.text();
    const workoutPlanJson = JSON.parse(aiResponse.replace(/```json/g, "").replace(/```/g, "").trim());

    await firestore.collection('users').doc(userId).set({ workoutPlan: workoutPlanJson }, { merge: true });

    return response.status(200).json({ success: true, message: 'Plano gerado com sucesso!' });

  } catch (error: any) {
    console.error("Erro:", error);
    return response.status(500).json({ error: error.message });
  }
}
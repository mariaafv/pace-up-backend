import { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
import OpenAI from "openai";

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

// --- SUPABASE ADMIN ---
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// --- OPENAI ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY as string,
});

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Método não permitido.' });
  }

  let userId: string | undefined;

  try {
    // 1️⃣ Verifica token do Firebase
    const firebaseToken = request.headers.authorization?.split('Bearer ')[1];
    if (!firebaseToken) return response.status(401).json({ error: 'Nenhum token fornecido.' });

    const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    userId = decodedToken.uid;

    const { profileData } = request.body;
    if (!profileData) return response.status(400).json({ error: 'profileData é obrigatório.' });

    // 2️⃣ Prompt para gerar plano mensal
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: "Você é um coach de corrida especialista em IA chamado PaceUp.",
      } as OpenAI.Chat.ChatCompletionSystemMessageParam,
      {
        role: "user",
        content: `
Um novo usuário se cadastrou com o seguinte perfil:
- Experiência: ${profileData.experience}
- Objetivo Final: ${profileData.goal}
- Peso: ${profileData.weight || "não informado"} kg
- Altura: ${profileData.height || "não informado"} cm
- Dias disponíveis para correr: ${profileData.run_days.join(", ")}

Sua tarefa é criar um plano de corrida **completo de 4 semanas (week1 a week4)**.
Para cada dia inclua:
- "day": Nome do dia da semana em pt-BR
- "type": Tipo do treino (Ex: Caminhada, Corrida leve, Intervalado, Descanso, Descanso ativo)
- "duration_minutes": número inteiro em minutos
- "description": descrição detalhada com dicas de respiração, postura e motivação.

Formato obrigatório de saída:
{
  "week1": [ { "day": "...", "type": "...", "duration_minutes": 30, "description": "..." }, ... ],
  "week2": [...],
  "week3": [...],
  "week4": [...]
}
`,
      } as OpenAI.Chat.ChatCompletionUserMessageParam,
    ];

    // 3️⃣ Chamada ao OpenAI
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini", // pode usar "gpt-4o-mini" para testes
      response_format: { type: "json_object" }, // força JSON válido
      messages,
    });

    const aiResponse = completion.choices[0].message?.content;
    if (!aiResponse) throw new Error("Resposta vazia da OpenAI.");

    let workoutPlanJson;
    try {
      workoutPlanJson = JSON.parse(aiResponse);
    } catch {
      throw new Error("Erro ao parsear JSON da IA.");
    }

    // 4️⃣ Validação mínima do plano
    if (!workoutPlanJson.week1 || !workoutPlanJson.week2 || !workoutPlanJson.week3 || !workoutPlanJson.week4) {
      throw new Error("Plano incompleto gerado pela IA.");
    }

    // 5️⃣ Salva no Supabase
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
      message: "Plano gerado com sucesso!",
      workout_plan: workoutPlanJson,
    });

  } catch (error: any) {
    console.error("❌ Erro na Vercel Function:", error.message);

    if (userId) {
      await supabaseAdmin.from('profiles').upsert({
        id: userId,
        planGenerationError: error.message,
        rawAIResponse: error.stack || "Nenhuma resposta recebida da IA."
      });
    }

    return response.status(500).json({ error: error.message });
  }
}

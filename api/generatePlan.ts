import { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
// MUDANÇA 1: Importa a biblioteca da OpenAI
import OpenAI from 'openai';

// --- INICIALIZAÇÕES ---
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

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL as string,
  process.env.SUPABASE_SERVICE_ROLE_KEY as string
);

// MUDANÇA 2: Inicializa o cliente da OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});
// --- FIM DAS INICIALIZAÇÕES ---

// --- HANDLER PRINCIPAL ---
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Método não permitido.' });
  }

  let userId: string | undefined;
  let aiResponse: string | undefined;

  try {
    console.log('=== PROCESSAMENTO INICIADO ===');

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

      Sua tarefa é criar um plano completo de treino para 4 semanas (week1 a week4).
      O formato da resposta deve ser um objeto JSON válido contendo as 4 semanas.
      As chaves do JSON devem ser: "week1", "week2", "week3", "week4".
      Cada semana deve ser um array de objetos, onde cada objeto representa um dia e contém as chaves: "day", "type", "duration_minutes", e "description".
      **IMPORTANTE: Todo o texto dentro do JSON, incluindo os valores para as chaves "day", "type" e "description", deve ser em português do Brasil.**
    `;

    console.log('Chamando API da OpenAI...');
    
    // MUDANÇA 3: Lógica para chamar a OpenAI com JSON Mode
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // Modelo mais recente e eficiente
      messages: [
        { role: "system", content: "Você é um assistente prestativo projetado para retornar respostas estritamente no formato JSON." },
        { role: "user", content: prompt }
      ],
      response_format: { type: "json_object" }, // Força a saída a ser um JSON válido
    });

    aiResponse = completion.choices[0].message.content ?? undefined;
    if (!aiResponse) throw new Error("A OpenAI não retornou conteúdo.");

    // MUDANÇA 4: O parse agora é direto e seguro, sem precisar do .match()
    const workoutPlanJson = JSON.parse(aiResponse);

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
    return response.status(200).json({ success: true, message: 'Plano gerado com sucesso!', workout_plan: workoutPlanJson });

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
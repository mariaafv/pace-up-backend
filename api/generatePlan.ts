import { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// --- INICIALIZAÇÃO ---
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

  // Usamos um bloco try/catch geral para capturar qualquer erro inesperado
  let userId; // Declarado aqui para estar acessível no catch
  let aiResponse; // Declarado aqui para estar acessível no catch

  try {
    const firebaseToken = request.headers.authorization?.split('Bearer ')[1];
    if (!firebaseToken) {
      return response.status(401).json({ error: 'Nenhum token fornecido.' });
    }

    const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    userId = decodedToken.uid;
    
    const { profileData } = request.body;
    if (!profileData) {
      return response.status(400).json({ error: 'profileData é obrigatório.' });
    }
    
    // --- LÓGICA DA IA ---
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY as string);
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash-latest" });

    // MUDANÇA 1: Prompt ainda mais rigoroso
    const prompt = `
      Você é um coach de corrida especialista em IA chamado PaceUp.
      Um novo usuário se cadastrou com o seguinte perfil:
      - Experiência: ${profileData.experience}
      - Objetivo Final: ${profileData.goal}
      - Peso: ${profileData.weight || "não informado"} kg
      - Altura: ${profileData.height || "não informado"} cm
      - Dias disponíveis para correr: ${profileData.run_days.join(", ")}

      Sua tarefa é gerar um plano de treino de corrida personalizado para a primeira semana.
      O plano deve ser apropriado para o nível de experiência e objetivo do usuário.
      Retorne a resposta EXCLUSIVAMENTE no seguinte formato JSON.
      IMPORTANTE: Sua resposta deve conter APENAS o objeto JSON, sem nenhuma palavra, saudação, explicação ou formatação de markdown como \`\`\`json. A resposta deve começar com '{' e terminar com '}'.
    `;
    
    const result = await model.generateContent(prompt);
    aiResponse = result.response.text(); // Armazena a resposta crua

    if (!aiResponse) {
        throw new Error("A IA não retornou conteúdo.");
    }

    // MUDANÇA 2: Lógica de extração de JSON mais robusta
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("Nenhum JSON válido encontrado na resposta da IA.");
    }
    
    const cleanedText = jsonMatch[0]; // Pega apenas a parte que corresponde ao JSON
    const workoutPlanJson = JSON.parse(cleanedText);
    
    // --- LÓGICA DE SALVAMENTO ---
    const finalUserData = {
      id: userId,
      ...profileData,
      workout_plan: workoutPlanJson,
      planGenerationError: null, // Limpa erros antigos
      rawAIResponse: null,       // Limpa respostas antigas
    };

    const { error } = await supabaseAdmin.from('profiles').upsert(finalUserData);

    if (error) throw error;

    console.log(`Plano gerado com sucesso para o usuário ${userId}`);
    return response.status(200).json({ success: true, message: 'Plano gerado com sucesso!' });

  } catch (error: any) {
    console.error("Erro na Vercel Function:", error.message);
    
    // MUDANÇA 3: Salva a resposta crua da IA no Supabase se houver erro
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
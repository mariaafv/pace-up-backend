import { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';
import { GoogleAuth } from 'google-auth-library';

// --- INICIALIZAÇÕES ---
let serviceAccountCredentials: any;

try {
  serviceAccountCredentials = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_KEY as string);
  
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccountCredentials),
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

// --- FUNÇÃO AUXILIAR ---
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

// --- FUNÇÃO PARA CHAMAR VERTEX AI DIRETAMENTE ---
async function callVertexAI(prompt: string): Promise<string> {
  try {
    console.log('Obtendo token de acesso...');
    
    // Usar GoogleAuth para obter token
    const auth = new GoogleAuth({
      credentials: serviceAccountCredentials,
      scopes: ['https://www.googleapis.com/auth/cloud-platform'],
    });
    
    const accessToken = await auth.getAccessToken();
    const projectId = serviceAccountCredentials.project_id;
    
    console.log(`Chamando VertexAI para projeto: ${projectId}`);
    
    // URL da API do Vertex AI
    const url = `https://us-central1-aiplatform.googleapis.com/v1/projects/${projectId}/locations/us-central1/publishers/google/models/gemini-1.5-flash:generateContent`;
    
    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: prompt
            }
          ]
        }
      ],
      generationConfig: {
        maxOutputTokens: 8192,
        temperature: 0.7,
        topP: 0.8,
        topK: 40
      },
      safetySettings: [
        {
          category: 'HARM_CATEGORY_HARASSMENT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        },
        {
          category: 'HARM_CATEGORY_HATE_SPEECH',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        },
        {
          category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        },
        {
          category: 'HARM_CATEGORY_DANGEROUS_CONTENT',
          threshold: 'BLOCK_MEDIUM_AND_ABOVE'
        }
      ]
    };

    console.log('Fazendo requisição para VertexAI...');
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Erro da API:', errorText);
      throw new Error(`Vertex AI Error: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    console.log('Resposta recebida com sucesso');
    
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      throw new Error('VertexAI não retornou texto válido');
    }
    
    return text;
    
  } catch (error: any) {
    console.error('Erro em callVertexAI:', error.message);
    throw error;
  }
}

// --- HANDLER PRINCIPAL ---
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Método não permitido.' });
  }

  let userId: string | undefined;
  let aiResponseText: string | undefined;

  try {
    console.log('=== INÍCIO DO PROCESSAMENTO ===');
    
    // Verificar credenciais
    if (!serviceAccountCredentials) {
      throw new Error('FIREBASE_SERVICE_ACCOUNT_KEY não configurada corretamente');
    }
    
    console.log(`Usando projeto: ${serviceAccountCredentials.project_id}`);
    console.log(`Service account: ${serviceAccountCredentials.client_email}`);

    // --- Autenticação do usuário ---
    const firebaseToken = request.headers.authorization?.split('Bearer ')[1];
    if (!firebaseToken) return response.status(401).json({ error: 'Nenhum token fornecido.' });

    const decodedToken = await admin.auth().verifyIdToken(firebaseToken);
    userId = decodedToken.uid;
    console.log(`Usuário autenticado: ${userId}`);

    const { profileData } = request.body;
    if (!profileData) return response.status(400).json({ error: 'profileData é obrigatório.' });

    const monthDays = generateMonthDays();

    const prompt = `
Você é um coach de corrida especialista em IA chamado PaceUp.
Um novo usuário se cadastrou com o seguinte perfil:
- Experiência: ${profileData.experience}
- Objetivo Final: ${profileData.goal}
- Dias disponíveis para correr: ${profileData.run_days.join(", ")}

Para o mês atual, a sequência completa de dias da semana é: ${monthDays.join(", ")}.
Por favor, alinhe o plano de 4 semanas a esta sequência de dias. Os dias de treino devem cair nos dias disponíveis para correr.

Sua tarefa é criar um plano completo de treino para 4 semanas (week1 a week4).
Retorne a resposta EXCLUSIVAMENTE em formato JSON, começando com '{' e terminando com '}'.
O formato deve ser:
{
  "week1": [{"day": "NomeDoDiaDaSemana", "type": "Tipo de Treino", "duration_minutes": 20, "description": "Descrição detalhada"}],
  "week2": [...],
  "week3": [...],
  "week4": [...]
}
`;

    console.log('Chamando VertexAI...');
    aiResponseText = await callVertexAI(prompt);
    
    if (!aiResponseText) {
      throw new Error("A IA não retornou conteúdo válido.");
    }

    console.log('Resposta recebida, processando JSON...');
    const jsonMatch = aiResponseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Nenhum JSON válido encontrado na resposta da IA.");
    
    const workoutPlanJson = JSON.parse(jsonMatch[0]);

    // Salvar no Supabase
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
    console.error("Stack:", error.stack);
    
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
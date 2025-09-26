import { VercelRequest, VercelResponse } from '@vercel/node';
import * as admin from 'firebase-admin';
import { createClient } from '@supabase/supabase-js';

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

// --- FUNÇÃO PARA CHAMAR GOOGLE AI STUDIO DIRETAMENTE ---
async function callGoogleAI(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY não configurada');
  }
  
  // Modelos para tentar em ordem
  const models = ['gemini-1.5-flash', 'gemini-1.5-pro', 'gemini-pro'];
  
  for (const model of models) {
    try {
      console.log(`Tentando modelo: ${model}`);
      
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  text: prompt
                }
              ]
            }
          ],
          generationConfig: {
            maxOutputTokens: 8192,
            temperature: 0.7
          }
        })
      });
      
      if (response.ok) {
        const data = await response.json();
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        
        if (text) {
          console.log(`✅ Sucesso com modelo: ${model}`);
          return text;
        }
      } else {
        const errorText = await response.text();
        console.log(`❌ Modelo ${model} falhou: ${response.status}`);
        
        // Se for 404, tentar próximo modelo
        if (response.status === 404) {
          continue;
        } else {
          throw new Error(`Google AI Error: ${response.status} ${response.statusText} - ${errorText}`);
        }
      }
    } catch (error: any) {
      console.log(`Erro com modelo ${model}:`, error.message);
      
      // Se for o último modelo, lançar erro
      if (model === models[models.length - 1]) {
        throw error;
      }
      continue;
    }
  }
  
  throw new Error('Nenhum modelo do Google AI funcionou');
}

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

    console.log('Chamando Google AI...');
    aiResponse = await callGoogleAI(prompt);
    
    if (!aiResponse) throw new Error("A IA não retornou conteúdo.");

    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("Nenhum JSON válido encontrado na resposta da IA.");
    const workoutPlanJson = JSON.parse(jsonMatch[0]);

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
const fs = require("node:fs");
const path = require("node:path");

const defaultComplaint = {
  id: "MW-2026-0715-001",
  channel: "online",
  category: "processing-delay",
  citizenMessage: "지난달에 제출한 민원 신청이 아직 처리되지 않았습니다. 왜 지연되는지, 언제 답변을 받을 수 있는지 알려주세요.",
  history: [],
  requestedOutput: ["citizenReply", "internalMemo", "validationLog"],
};

function loadEnv() {
  const envPath = path.join(process.cwd(), ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    process.env[key] = valueParts.join("=").replace(/^[ '\"]|[ '\"]$/g, "").trim();
  }
}
function fallbackAgents() {
  return {
    intake(input) {
      return {
        agent: "Intake Agent",
        stage: "input",
        summary: "신청 처리 지연 사유와 예상 답변 시점을 요청한 민원입니다.",
        extractedIssues: ["처리 지연 설명 필요", "예상 처리 일정 안내 필요", "현재 담당 부서 확인 필요"],
        missingInformation: ["담당 부서의 최신 처리 상태", "실제 완료 예정일"],
        source: input.citizenMessage,
      };
    },
    policy(input, intake) {
      return {
        agent: "Policy Agent",
        stage: "processing",
        criteria: [
          "민원 답변은 지연 사유, 현재 진행 상태, 후속 조치 계획을 포함한다.",
          "확정되지 않은 처리일은 단정하지 않는다.",
          "개인정보와 내부 검토 세부 내용은 필요한 범위에서만 안내한다.",
        ],
        evidenceNeeded: intake.missingInformation,
        sourceBasis: input.history,
      };
    },
    response(input, intake, policy) {
      const citizenReplyDraft = "안녕하세요. 문의하신 민원은 현재 담당 부서에서 검토 중입니다. 처리가 지연된 점에 대해 불편을 드려 죄송합니다. 현재 기록상 보완 검토가 진행된 이력이 있어 담당 부서의 최신 진행 상태와 예상 처리 일정을 확인한 뒤 안내드리겠습니다. 확인 결과가 정리되는 즉시 후속 답변을 드리겠습니다.";
      return {
        agent: "Response Agent",
        stage: "processing",
        citizenReplyDraft,
        internalMemo: {
          complaintId: input.id,
          issue: intake.summary,
          requiredAction: "담당 부서에 최신 처리 상태와 예상 답변 가능일 확인 요청",
          policyBasis: policy.criteria,
        },
      };
    },
    qa(intake, policy, response) {
      const checks = [
        { name: "issue-coverage", passed: response.citizenReplyDraft.includes("지연") && response.citizenReplyDraft.includes("일정"), detail: "지연 사유와 일정 문의에 모두 대응했습니다." },
        { name: "missing-facts", passed: false, detail: intake.missingInformation.join(", ") + " 확인이 필요합니다." },
        { name: "policy-alignment", passed: policy.criteria.length >= 3, detail: "답변 기준, 단정 금지, 개인정보 제한 기준을 반영했습니다." },
      ];
      return { agent: "QA Agent", stage: "validation", checks, passed: checks.every((check) => check.passed), requiredFixes: checks.filter((check) => !check.passed).map((check) => check.detail) };
    },
    compliance() {
      return { agent: "Compliance Agent", stage: "validation", passed: true, tone: "polite", riskLevel: "low", notes: ["단정적 표현 없이 확인 후 안내하는 구조입니다."] };
    },
  };
}

const agents = fallbackAgents();

function jsonPrompt(role, input) {
  return [
    `당신은 ${role}입니다.`,
    "민원 처리 멀티 에이전트 하네스의 한 단계만 수행하세요.",
    "반드시 JSON만 반환하세요. 마크다운 코드블록은 쓰지 마세요.",
    "입력:",
    JSON.stringify(input, null, 2),
  ].join("\n");
}

function extractJson(text) {
  const trimmed = text.trim().replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/i, "").trim();
  return JSON.parse(trimmed);
}

async function callOpenRouter(role, payload) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.includes("your_openrouter_api_key_here")) throw new Error("OPENROUTER_API_KEY is missing or still set to the placeholder. Update .env with your real OpenRouter key.");

  const model = process.env.OPENROUTER_MODEL || "openai/gpt-4o-mini";
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": process.env.OPENROUTER_SITE_URL || "http://localhost/minwon-multi-agent-harness",
      "X-Title": process.env.OPENROUTER_APP_NAME || "Minwon Multi Agent Harness",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a precise Korean civil complaint processing agent. Return valid JSON only." },
        { role: "user", content: jsonPrompt(role, payload) },
      ],
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter ${response.status}: ${body}`);
  }

  const data = await response.json();
  return extractJson(data.choices?.[0]?.message?.content || "{}");
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null || value === "") return [];
  return [String(value)];
}

function normalizeAgentOutputs(intake, policy, response, qa, compliance) {
  intake.extractedIssues = asArray(intake.extractedIssues);
  intake.missingInformation = asArray(intake.missingInformation);
  policy.criteria = asArray(policy.criteria);
  policy.evidenceNeeded = asArray(policy.evidenceNeeded);
  policy.riskNotes = asArray(policy.riskNotes);
  response.citizenReplyDraft = response.citizenReplyDraft || response.reply || response.answer || "답변 초안이 생성되지 않았습니다.";
  response.internalMemo = response.internalMemo || { requiredAction: "담당 부서 확인 필요" };
  qa.checks = asArray(qa.checks).map((check, index) => {
    if (typeof check === "object") return { name: check.name || `check-${index + 1}`, passed: Boolean(check.passed), detail: check.detail || check.message || JSON.stringify(check) };
    return { name: `check-${index + 1}`, passed: false, detail: String(check) };
  });
  qa.passed = Boolean(qa.passed);
  qa.requiredFixes = asArray(qa.requiredFixes);
  compliance.passed = Boolean(compliance.passed);
  compliance.riskLevel = compliance.riskLevel || "unknown";
  compliance.notes = asArray(compliance.notes);
}
function buildResult(input, intake, policy, response, qa, compliance, mode) {
  normalizeAgentOutputs(intake, policy, response, qa, compliance);
  return {
    harness: "Complaint Multi-Agent Harness",
    mode,
    flow: "Input -> Processing -> Validation -> Output",
    input,
    processing: { intake, policy, response },
    validation: { qa, compliance },
    output: {
      status: qa.passed && compliance.passed ? "ready" : "needs_follow_up",
      citizenReply: response.citizenReplyDraft,
      internalMemo: response.internalMemo,
      validationLog: [...qa.checks, ...compliance.notes.map((detail) => ({ name: "compliance", passed: compliance.passed, detail }))],
      nextActions: qa.requiredFixes || [],
    },
  };
}

function orchestrate(input = defaultComplaint) {
  const intake = agents.intake(input);
  const policy = agents.policy(input, intake);
  const response = agents.response(input, intake, policy);
  const qa = agents.qa(intake, policy, response);
  const compliance = agents.compliance(response);
  return buildResult(input, intake, policy, response, qa, compliance, "local-fallback");
}

async function orchestrateOpenRouter(input = defaultComplaint) {
  loadEnv();
  const intake = await callOpenRouter("Intake Agent: 민원 요약, 쟁점 추출, 부족 정보 식별. 출력 필드: agent, stage, summary, extractedIssues, missingInformation", { input });
  const policy = await callOpenRouter("Policy Agent: 처리 기준, 답변 원칙, 리스크 기준 정리. 출력 필드: agent, stage, criteria, evidenceNeeded, riskNotes", { input, intake });
  const response = await callOpenRouter("Response Agent: 시민 답변 초안과 내부 메모 작성. 출력 필드: agent, stage, citizenReplyDraft, internalMemo", { input, intake, policy });
  const qa = await callOpenRouter("QA Agent: 누락, 사실 확인 필요 항목, 답변 품질 검증. 출력 필드: agent, stage, checks, passed, requiredFixes", { input, intake, policy, response });
  const compliance = await callOpenRouter("Compliance Agent: 단정 표현, 개인정보, 정책 리스크 검토. 출력 필드: agent, stage, passed, tone, riskLevel, notes", { input, response, qa });
  return buildResult(input, intake, policy, response, qa, compliance, "openrouter");
}

function printReport(result) {
  console.log("# Complaint Multi-Agent Harness Demo\n");
  console.log(`Mode: ${result.mode}`);
  console.log(`Flow: ${result.flow}\n`);
  console.log("## Input");
  console.log(`- Complaint ID: ${result.input.id}`);
  console.log(`- Message: ${result.input.citizenMessage}\n`);
  console.log("## Processing");
  console.log(`- ${result.processing.intake.agent}: ${result.processing.intake.summary}`);
  console.log(`- ${result.processing.policy.agent}: ${result.processing.policy.criteria.length} handling criteria selected`);
  console.log(`- ${result.processing.response.agent}: citizen reply and internal memo drafted\n`);
  console.log("## Validation");
  console.log(`- ${result.validation.qa.agent}: ${result.validation.qa.passed ? "passed" : "needs follow-up"}`);
  console.log(`- ${result.validation.compliance.agent}: ${result.validation.compliance.riskLevel} risk\n`);
  console.log("## Output");
  console.log(`- Status: ${result.output.status}`);
  console.log(`- Citizen Reply: ${result.output.citizenReply}`);
  console.log(`- Next Actions: ${result.output.nextActions.length ? result.output.nextActions.join("; ") : "none"}`);
}

async function main() {
  const useOpenRouter = process.argv.includes("--openrouter");
  const result = useOpenRouter ? await orchestrateOpenRouter() : orchestrate();
  const jsonIndex = process.argv.indexOf("--json-out");
  if (jsonIndex >= 0 && process.argv[jsonIndex + 1]) {
    fs.writeFileSync(process.argv[jsonIndex + 1], JSON.stringify(result, null, 2), "utf8");
  }
  printReport(result);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { agents, defaultComplaint, orchestrate, orchestrateOpenRouter };








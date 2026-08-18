import { agent, compute, defineWorkflow } from "@osolmaz/pi-workflows";

type AutodeviseInput = {
  task?: string;
  scope?: string;
  constraints?: string[];
};

/**
 * Turn a discussed problem into a chosen, practical solution and a detailed
 * implementation plan. The ideal end state informs the choice but cannot
 * force work outside the current scope or authority.
 */
export default defineWorkflow({
  name: "autodevise",
  title: ({ input }) => {
    const task = (input as AutodeviseInput).task;
    return task ? `autodevise: ${task.slice(0, 60)}` : "Devise a practical solution";
  },
  presentationPrompt: [
    "Present the selected practical solution and its implementation plan.",
    "Briefly state how the ideal end state informed the choice and what was excluded as outside scope.",
    "Do not ask the user to choose between the options.",
  ].join("\n"),
  startAt: "frame",
  maxSteps: 10,
  nodes: {
    frame: agent({
      statusDetail: "framing the problem",
      prompt: ({ input }) => {
        const { task, scope, constraints } = input as AutodeviseInput;
        return [
          `Frame the problem: ${task ?? "the problem discussed so far in this conversation"}.`,
          `Authorized scope: ${scope ?? "infer it conservatively from the user's request and the current project"}.`,
          `Explicit constraints: ${JSON.stringify(constraints ?? [])}.`,
          "Identify the goal, success criteria, in-scope systems, out-of-scope systems, and interfaces we control.",
          "Do not invent permission to change an upstream project, external service, or unrelated repository.",
        ].join("\n");
      },
      expectedOutput: `{ "problem": "concise problem statement", "success": ["observable success criterion"], "inScope": ["system or change"], "outOfScope": ["system or change"], "constraints": ["constraint"], "controlBoundary": "what can be changed directly" }`,
    }),
    propose: agent({
      statusDetail: "devising a solution",
      prompt: ({ outputs }) =>
        [
          "Devise the most elegant, long-term production-ready solution within the framed scope.",
          "Prefer a small number of general parts, clear ownership boundaries, and existing public interfaces.",
          "Avoid one-off mechanisms and unnecessary infrastructure.",
          "Do not implement anything yet.",
          "",
          `Problem frame: ${JSON.stringify(outputs.frame)}`,
        ].join("\n"),
      expectedOutput: `{ "solution": "concrete proposed solution", "rationale": "why it is the best long-term design", "parts": ["main part"], "tradeoffs": ["important trade-off"] }`,
    }),
    ideal: agent({
      statusDetail: "describing the ideal end state",
      prompt: ({ outputs }) =>
        [
          "Set the proposal aside and describe the holy grail for this problem.",
          "The holy grail is the ideal end state and may exceed the current work scope.",
          "Name every dependency that is outside our authority instead of assuming it can be changed.",
          "Explain what practical value the ideal adds beyond the proposal.",
          "Do not implement anything yet.",
          "",
          `Problem frame: ${JSON.stringify(outputs.frame)}`,
          `Proposal: ${JSON.stringify(outputs.propose)}`,
        ].join("\n"),
      expectedOutput: `{ "ideal": "ideal end state", "outsideDependencies": ["dependency outside our authority"], "additionalValue": ["benefit beyond the proposal"] }`,
    }),
    choose: agent({
      statusDetail: "choosing the practical solution",
      prompt: ({ outputs }) =>
        [
          "Choose the right solution without asking the user to decide between the proposal and the holy grail.",
          "Choose the holy grail when it is production-ready, proportionate, within scope, and implementable through interfaces we control.",
          "Otherwise choose the strongest practical in-scope solution that preserves a clear path toward the ideal.",
          "Do not block only because the ideal requires work outside our authority.",
          "Do not make an upstream change, unrelated repository, new service, or unapproved resource a requirement.",
          "Prefer the simpler solution when two options provide materially equivalent results.",
          "Return `blocked` only when no truthful in-scope solution can meet the success criteria.",
          "",
          `Problem frame: ${JSON.stringify(outputs.frame)}`,
          `Proposal: ${JSON.stringify(outputs.propose)}`,
          `Holy grail: ${JSON.stringify(outputs.ideal)}`,
        ].join("\n"),
      expectedOutput: `{ "status": "ready" | "blocked", "selected": "chosen practical solution", "why": "why this is the right choice", "relationshipToIdeal": "how it matches or evolves toward the ideal", "excluded": ["outside-scope requirement not selected"], "compromises": ["accepted compromise"] }`,
    }),
    plan: agent({
      timeoutMs: 30 * 60_000,
      statusDetail: "writing the implementation plan",
      prompt: ({ outputs }) =>
        [
          "Write a detailed, implementation-ready plan for the selected solution.",
          "Keep every step inside the framed scope and authority.",
          "For each step, state what changes, where it changes, and how to verify it.",
          "Include contract changes, compatibility boundaries, tests, rollout or migration work, and failure handling when they apply.",
          "Do not add speculative work or require any excluded dependency.",
          "Do not implement the plan.",
          "",
          `Problem frame: ${JSON.stringify(outputs.frame)}`,
          `Selection: ${JSON.stringify(outputs.choose)}`,
        ].join("\n"),
      expectedOutput: `{ "summary": "implementation approach", "steps": [{ "change": "specific change", "where": "component or file area", "verification": "evidence that proves it works" }], "contracts": ["contract impact"], "tests": ["required test"], "risks": [{ "risk": "risk", "mitigation": "mitigation" }], "boundaries": ["work explicitly excluded"] }`,
    }),
    blocked: compute({
      run: ({ outputs }) => ({
        status: "blocked",
        frame: outputs.frame,
        proposal: outputs.propose,
        ideal: outputs.ideal,
        selection: outputs.choose,
      }),
    }),
    finalize: compute({
      run: ({ outputs }) => ({
        status: "ready",
        frame: outputs.frame,
        proposal: outputs.propose,
        ideal: outputs.ideal,
        selection: outputs.choose,
        plan: outputs.plan,
      }),
    }),
  },
  edges: [
    { from: "frame", to: "propose" },
    { from: "propose", to: "ideal" },
    { from: "ideal", to: "choose" },
    {
      from: "choose",
      switch: {
        on: "$.status",
        cases: {
          ready: "plan",
          blocked: "blocked",
        },
      },
    },
    { from: "plan", to: "finalize" },
  ],
});

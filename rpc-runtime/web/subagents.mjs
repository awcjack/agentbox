import { element, renderMarkdown } from "./markdown.mjs";

// Return null for other tools or unstructured errors so the generic renderer can handle them.
export function renderSubagents(call, result, key) {
  if ((call.name || result?.toolName) !== "task") return null;
  let args = call.arguments ?? result?.args;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { args = null; }
  }
  const validJobs = (value) => Array.isArray(value) && value.length > 0 && value.every((job) => job && typeof job === "object" && typeof job.role === "string");
  let jobs = result?.details?.jobs;
  if (!validJobs(jobs)) {
    // Persisted results from before job progress was added remain readable.
    jobs = result?.details?.results;
    if (!validJobs(jobs)) {
      if (result && !result.running) return null;
      jobs = args?.jobs ?? (args?.role ? [args] : null);
      if (!validJobs(jobs)) return null;
      jobs = jobs.map((job) => ({ ...job, taskId: job.resume, resumed: Boolean(job.resume), status: result?.running ? "running" : "requested" }));
    }
  }
  const root = element("section", "subagents");
  root.append(element("div", "tool-label", "SUBAGENTS / THIS CONVERSATION"));
  for (const [index, job] of jobs.entries()) {
    const status = typeof job.status === "string" ? job.status : "unknown";
    const card = element("details", `tool-detail${["failed", "cancelled", "step_limit"].includes(status) ? " error" : ""}`);
    // Index is stable from queued to running, before a child session ID exists.
    card.dataset.detailKey = `tool:${key}:job:${index}`;
    const summary = element("summary", "", `${index + 1}. ${job.role}`);
    summary.append(element("span", "tool-state", status.replaceAll("_", " ")));
    card.append(summary);
    if (job.taskId) card.append(element("div", "tool-label", `${job.resumed ? "RESUMED CHILD" : "CHILD"}: ${job.taskId}`));
    if (Number.isInteger(job.steps)) card.append(element("div", "tool-label", `${job.steps} assistant steps`));
    if (typeof job.prompt === "string") card.append(element("div", "tool-label", "TASK"), element("pre", "", job.prompt));
    if (typeof job.output === "string" && job.output) card.append(renderMarkdown(job.output));
    if (typeof job.stderr === "string" && job.stderr) card.append(element("div", "tool-label", "STDERR"), element("pre", "", job.stderr));
    if (job.outputTruncated || job.stderrTruncated) card.append(element("p", "tool-label", "Captured output truncated."));
    root.append(card);
  }
  return root;
}

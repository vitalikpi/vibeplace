// ✅ Unblocked: tell the Job Tracker the agent can carry on in this tab.
// Ships with the app (it's part of the workflow, not tied to any site). The job is
// found by "#<id>" in the tab title, which agents add when they hand a tab back, else
// by this page's URL. An optional short answer goes to the agent with the unblock.
(() => {
  const m = /#(\d+)\b/.exec(document.title);
  const answer = prompt("Unblock " + (m ? "job #" + m[1] : "this job") + "? Optional answer for the agent:", "");
  if (answer === null) return;
  const req = { op: "unblock", url: location.href, title: document.title };
  if (m) req.job_id = Number(m[1]);
  if (answer.trim()) req.answers = answer.trim();
  window.open("http://127.0.0.1:7085/act#" + encodeURIComponent(JSON.stringify(req)), "_blank", "width=440,height=180");
})();

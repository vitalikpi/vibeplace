// ✅ Unblocked: tell vibeplace the agent can carry on in this tab.
// Ships with the app (it's part of the workflow, not tied to any site). The job is
// found by "#<id>" in the tab title, which agents add when they hand a tab back, else
// by this page's URL.
(() => {
  const m = /#(\d+)\b/.exec(document.title);
  if (!confirm("Unblock " + (m ? "job #" + m[1] : "this job") + "? The agent carries on in this tab.")) return;
  const req = { op: "unblock", url: location.href, title: document.title };
  if (m) req.job_id = Number(m[1]);
  window.open("http://127.0.0.1:7085/act#" + encodeURIComponent(JSON.stringify(req)), "_blank", "width=440,height=180");
})();

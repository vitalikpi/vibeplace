// The same rules the main process enforces (electron/workflow.js is plain ESM with no
// Node imports), so the UI only offers moves the backend will accept.
export * from "../electron/workflow.js";

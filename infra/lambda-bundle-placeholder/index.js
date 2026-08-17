// Placeholder function code, replaced by the built server bundle at deploy
// time (issue 39, via the bwu:codeAssetPath context key). It exists so the
// stack synthesizes from a clean checkout with no build step, and it answers
// rather than crashing so a stack deployed by accident is diagnosable.
exports.handler = async () => ({
  statusCode: 503,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ code: "internal_error", message: "No server bundle deployed." }),
});

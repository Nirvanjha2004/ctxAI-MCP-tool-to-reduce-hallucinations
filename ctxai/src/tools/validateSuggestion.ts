// Add this import to src/index.ts
import { validateSuggestion } from "./tools/validateSuggestion.js";

// ... inside the setRequestHandler switch:
case "validate_suggestion": {
  const { code, contextFingerprint } = args as { code: string; contextFingerprint: string };
  
  if (!code || !contextFingerprint) {
    throw new Error("Missing required arguments for validate_suggestion");
  }

  const warnings = await validateSuggestion(code, contextFingerprint);
  return {
    content: [{
      type: "text",
      text: warnings.length > 0 
        ? JSON.stringify({ status: "warnings", issues: warnings }, null, 2)
        : JSON.stringify({ status: "ok", message: "No hallucinations detected." })
    }]
  };
}
// Vite's `?raw` suffix imports a file's text as a string (story-graph.test.tsx reads
// StoryGraph.css this way). Vitest resolves it at run time; this declaration gives
// the test project the same module shape. Test-side only: src never imports `?raw`.
declare module "*.css?raw" {
  const content: string;
  export default content;
}

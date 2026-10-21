# Project: free online tools website
- Static Astro site, no backend, no database.
- Every tool runs fully in the browser. Files are never uploaded.
- One page per tool under src/pages/ (e.g. csv-to-json.astro).
- Shared layout in src/layouts/ToolLayout.astro with header, footer, SEO tags.
- Each tool page needs: unique title, meta description, H1, short intro,
  how-to steps, FAQ, and a "your files never leave your browser" note.
- Keep JS small, mobile-friendly, no heavy frameworks.
- Tool logic goes in src/scripts/<tool-name>.js
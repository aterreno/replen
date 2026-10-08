// Vercel entrypoint. The API is compiled by SWC into dist/ during the build (decorator metadata needs SWC),
// so the entrypoint must be a file that exists before the build and imports the compiled output.
import "./dist/main.js";

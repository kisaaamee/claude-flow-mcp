import { launchChrome } from "./browser.js";
import { PROFILE_DIR } from "./config.js";

// Opens the server's Chrome on Google Flow so the user can sign in by hand. The sign-in stays in this profile.
await launchChrome();
console.log(`Chrome is open with the profile ${PROFILE_DIR}.`);
console.log("Sign in to Google in that window, open flow.google.com, then close this terminal. Chrome can stay open.");

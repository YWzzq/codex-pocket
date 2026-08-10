import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "cc.cd.dogbot.codexpocket",
  appName: "Codex Pocket",
  webDir: "www",
  server: {
    url: "https://codex.dogbot.cc.cd",
    cleartext: false,
    androidScheme: "https",
  },
};

export default config;

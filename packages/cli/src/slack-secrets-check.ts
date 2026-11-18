// workspaces-o9o.151 (CoS decision 3): the `rig doctor` row for the Slack secrets env file. The daemon reads that file under the
// credential rule and, when the rule refuses it, leaves Slack off (the daemon still starts). This row says so, with the file and
// the fix, which are the rule's own refusal message. A WARN, never a FAIL: Slack is optional and nothing else is affected.
import { readCredentialFile, SLACK_SECRETS_POLICY, type CredentialFileRead } from "@openrig/daemon/credential-file";

export interface SlackSecretsRow {
  name: "slack_secrets";
  status: "pass" | "warn" | "skipped";
  message: string;
  reason?: string;
  fix?: string;
}

export function judgeSlackSecretsFile(
  envFile: string | null,
  read: (p: string) => CredentialFileRead = (p) => readCredentialFile(p, SLACK_SECRETS_POLICY),
): SlackSecretsRow {
  const name = "slack_secrets";
  if (!envFile) return { name, status: "skipped", message: "No Slack secrets file is configured." };
  const result = read(envFile);
  if (result.ok) return { name, status: "pass", message: `Slack secrets file ${envFile} is a plain file of yours that nobody else can read.` };
  if (result.problem === "missing") {
    return { name, status: "skipped", message: `The configured Slack secrets file ${envFile} does not exist; rig slack status covers Slack setup.` };
  }
  return {
    name,
    status: "warn",
    message: `Slack is off: OpenRig does not read its secrets file ${envFile}.`,
    reason: "The secrets file fails the credential file check, so its tokens are not used.",
    fix: result.message,
  };
}

/** The configured secrets file of the Slack connector in `home`, read through the daemon's own config loader. */
export async function configuredSlackSecretsEnvFile(home: string): Promise<string | null> {
  const { loadConfig } = await import("@openrig/daemon/gateway-slack");
  return loadConfig(home).secretsEnvFile ?? null;
}

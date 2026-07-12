import { BridgeMessage } from './types';

/**
 * Both claude.exe and codex.exe are coding-agent CLIs — invoked with real OAuth login
 * (not `--bare`/an API key, per the deployment's whole point of reusing the host's
 * subscription) they load their full agent harness by default, tool definitions
 * included. `--tools ""` (claude) / `--sandbox read-only` (codex) stop them from
 * *actually* running anything, but neither flag stops the model from *believing* it has
 * tools and fabricating a plausible-looking "I ran the command, here's the output"
 * answer — confirmed by hand: `--tools ""` + "run whoami" produced a fabricated
 * hostname/user, not an error. This preamble is the only mitigation for that: told
 * explicitly it has no tools, the model declines instead of confabulating.
 */
const SAFETY_PREAMBLE =
  'You are a helpful assistant embedded in a chat product. You have no tools ' +
  'available: no shell access, no file access, no internet/browser access, and no '
    + 'memory of anything outside this conversation. Never claim to have run a command, '
    + 'read a file, or fetched a URL — you can only answer from your own knowledge. If a '
    + 'request needs a tool you do not have, say so plainly instead of inventing a ' +
  'plausible-looking result.';

export interface BuiltPrompt {
  systemPrompt: string;
  promptText: string;
}

/**
 * Both CLIs' non-interactive modes take one prompt string, not a message array — so the
 * full conversation is flattened into a transcript, the same "resend full history every
 * turn" shape the existing HTTP-based providers already use (`AiChatRequest.messages`),
 * just serialized to text instead of a JSON array.
 */
export function buildPrompt(messages: BridgeMessage[]): BuiltPrompt {
  const systemParts = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content);
  const turns = messages.filter((message) => message.role !== 'system');
  const promptText = turns
    .map(
      (message) =>
        `${message.role === 'user' ? 'Human' : 'Assistant'}: ${message.content}`,
    )
    .join('\n\n');

  return {
    systemPrompt: [SAFETY_PREAMBLE, ...systemParts].join('\n\n'),
    promptText,
  };
}

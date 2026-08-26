import { execFileSync } from 'node:child_process';
import { resolveTmuxBinaryForPlatform } from '../utils/platform-command.js';

/**
 * Reports whether any tmux client is attached to the session this HUD pane
 * belongs to. Used by watch mode to avoid render-only work (state reads, git
 * subprocess spawns, tmux reconciliation, stdout writes) while nobody is
 * looking at the pane. (closes #3577)
 *
 * Returns true (assume attached) whenever the answer is unknown, so the HUD
 * keeps rendering on non-tmux terminals, when tmux is unavailable, or on any
 * query failure — detached suppression only happens on a trusted "0".
 */
export function isHudWatchSessionAttached(
  deps: {
    env?: NodeJS.ProcessEnv;
    execTmuxSync?: (args: string[]) => string;
  } = {},
): boolean {
  const env = deps.env ?? process.env;
  if (!env.TMUX) return true;

  const exec = deps.execTmuxSync ?? ((args: string[]) => {
    const binary = resolveTmuxBinaryForPlatform() || 'tmux';
    return execFileSync(binary, args, {
      encoding: 'utf-8',
      ...(process.platform === 'win32' ? { windowsHide: true } : {}),
    });
  });

  const query = (paneId: string): boolean => {
    const output = exec(['display-message', '-p', '-t', paneId, '#{session_attached}']).trim();
    return output !== '0';
  };

  const paneId = env.TMUX_PANE?.trim();
  if (paneId) {
    try {
      return query(paneId);
    } catch {
      return true;
    }
  }

  // No pane id in env (unusual for a real HUD pane); fall back to the active
  // pane of the server described by $TMUX, which is the same session in the
  // single-session layouts OMX launches.
  try {
    return query('');
  } catch {
    return true;
  }
}

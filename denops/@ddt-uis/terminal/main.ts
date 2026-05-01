import type { BaseParams, DdtOptions, UiOptions } from "@shougo/ddt-vim/types";
import { BaseUi, type UiActions } from "@shougo/ddt-vim/ui";
import { printError, safeStat } from "@shougo/ddt-vim/utils";

import type { Denops } from "@denops/std";
import * as fn from "@denops/std/function";
import * as vars from "@denops/std/variable";
import * as nvimOp from "@denops/std/option/nvim";
import { batch } from "@denops/std/batch";
import { type RawString, rawString, useEval } from "@denops/std/eval";

// Debounce delay for Vim8 terminal redraws (ms).
// Collapsing rapid successive redraws (e.g. sending many lines quickly) into a
// single update avoids UI stalls without introducing noticeable lag.
const TERM_REDRAW_DEBOUNCE_DELAY = 75;

// Per-buffer pending debounce timer IDs (Vim8 path only).
// Entries are removed when the timer fires, so the map stays small and
// does not require explicit cleanup on buffer close.
const termRedrawTimers = new Map<number, number>();

export type Params = {
  command: string[];
  cwd: string;
  extraTermOptions: Record<string, unknown>;
  floatingBorder: string;
  promptPattern: string;
  split: string;
  startInsert: boolean;
  toggle: boolean;
  winCol: number;
  winHeight: number;
  winRow: number;
  winWidth: number;
};

type CdParams = {
  directory: string;
};

type SendParams = {
  str: string;
};

type SetPrompt = {
  str: string;
};

export class Ui extends BaseUi<Params> {
  #bufNr = -1;
  #jobid = -1;
  #pid = -1;

  override async redraw(args: {
    denops: Denops;
    options: DdtOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<void> {
    const cwd = args.uiParams.cwd === ""
      ? await fn.getcwd(args.denops)
      : args.uiParams.cwd;
    const stat = await safeStat(cwd);
    if (!stat || !stat.isDirectory) {
      // TODO: Create the directory.
      const result = await fn.confirm(
        args.denops,
        `${cwd} is not directory.  Create?`,
        "&Yes\n&No\n&Cancel",
      );
      if (result != 1) {
        return;
      }

      await fn.mkdir(args.denops, cwd, "p");
    }

    if (await fn.bufexists(args.denops, this.#bufNr)) {
      await this.#switchBuffer(args.denops, args.uiParams, cwd);
    } else {
      await this.#newBuffer(args.denops, args.uiParams);
    }

    await this.#initVariables(args.denops, args.options.name, cwd);
  }

  override async getInput(args: {
    denops: Denops;
    options: DdtOptions;
    uiOptions: UiOptions;
    uiParams: Params;
  }): Promise<string> {
    if (
      args.uiParams.promptPattern === "" ||
      await fn.bufnr(args.denops, "%") != this.#bufNr
    ) {
      return "";
    }

    // Batch RPCs: get command line, column and mode in one eval to reduce roundtrips.
    const { commandLine, col, mode } = await useEval(
      args.denops,
      async (denops: Denops) => {
        const currentLine = await fn.getline(denops, ".");
        const commandLine = await fn.substitute(
          denops,
          currentLine,
          args.uiParams.promptPattern,
          "",
          "",
        );
        const col = await fn.col(denops, ".");
        const mode = await fn.mode(denops);
        return { commandLine, col, mode } as {
          commandLine: string;
          col: number;
          mode: string;
        };
      },
    );

    return commandLine.slice(0, mode == "n" ? col - 2 : col - 3);
  }

  override actions: UiActions<Params> = {
    cd: {
      description: "Change current directory",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        actionParams: BaseParams;
      }) => {
        const curBuf = await fn.bufnr(args.denops, "%");
        if (curBuf != this.#bufNr) {
          return;
        }

        const params = args.actionParams as CdParams;

        await this.#cd(args.denops, params.directory);
      },
    },
    executeLine: {
      description: "Execute the command line",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
      }) => {
        const curBuf = await fn.bufnr(args.denops, "%");
        if (
          args.uiParams.promptPattern === "" ||
          curBuf != this.#bufNr
        ) {
          return;
        }

        // Batch retrieval of command line
        const { commandLine } = await useEval(
          args.denops,
          async (denops: Denops) => {
            const currentLine = await fn.getline(denops, ".");
            const commandLine = await fn.substitute(
              denops,
              currentLine,
              args.uiParams.promptPattern,
              "",
              "",
            );
            return { commandLine } as { commandLine: string };
          },
        );

        await jobSendString(
          args.denops,
          this.#bufNr,
          this.#jobid,
          rawString`${commandLine}\<CR>`,
        );
      },
    },
    insert: {
      description: "Insert the string to terminal",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as SendParams;

        await jobSendString(
          args.denops,
          this.#bufNr,
          this.#jobid,
          rawString`${params.str}`,
        );
      },
    },
    nextPrompt: {
      description: "Move to the next prompt from cursor",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
        actionParams: BaseParams;
      }) => {
        const curBuf = await fn.bufnr(args.denops, "%");
        if (
          args.uiParams.promptPattern === "" ||
          curBuf != this.#bufNr
        ) {
          return;
        }

        await searchPrompt(
          args.denops,
          args.uiParams.promptPattern,
          "Wn",
        );
      },
    },
    pastePrompt: {
      description: "Paste the history to the command line",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
      }) => {
        const curBuf = await fn.bufnr(args.denops, "%");
        if (
          args.uiParams.promptPattern === "" ||
          curBuf != this.#bufNr
        ) {
          return;
        }

        const { commandLine } = await useEval(
          args.denops,
          async (denops: Denops) => {
            const currentLine = await fn.getline(denops, ".");
            const commandLine = await fn.substitute(
              denops,
              currentLine,
              args.uiParams.promptPattern,
              "",
              "",
            );
            return { commandLine } as { commandLine: string };
          },
        );
        await jobSendString(
          args.denops,
          this.#bufNr,
          this.#jobid,
          rawString`${commandLine}`,
        );
      },
    },
    previousPrompt: {
      description: "Move to the previous prompt from cursor",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
        actionParams: BaseParams;
      }) => {
        const curBuf = await fn.bufnr(args.denops, "%");
        if (
          args.uiParams.promptPattern === "" ||
          curBuf != this.#bufNr
        ) {
          return;
        }

        await searchPrompt(
          args.denops,
          args.uiParams.promptPattern,
          "bWn",
        );
      },
    },
    redraw: {
      description: "Redraw the UI",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        uiParams: Params;
      }) => {
        const curBuf = await fn.bufnr(args.denops, "%");
        if (curBuf != this.#bufNr) {
          return;
        }

        await termRedraw(args.denops, this.#bufNr);
      },
    },
    send: {
      description: "Send the string to terminal",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as SendParams;

        await jobSendString(
          args.denops,
          this.#bufNr,
          this.#jobid,
          rawString`${params.str}\<CR>`,
        );

        await termRedraw(args.denops, this.#bufNr);
      },
    },
    setPrompt: {
      description: "Set the string to prompt",
      callback: async (args: {
        denops: Denops;
        options: DdtOptions;
        actionParams: BaseParams;
      }) => {
        const params = args.actionParams as SetPrompt;

        await jobSendString(
          args.denops,
          this.#bufNr,
          this.#jobid,
          rawString`${params.str}`,
        );

        await termRedraw(args.denops, this.#bufNr);
      },
    },
  };

  override params(): Params {
    return {
      command: [],
      cwd: "",
      extraTermOptions: {},
      floatingBorder: "",
      promptPattern: "",
      split: "",
      startInsert: false,
      toggle: false,
      winCol: 50,
      winHeight: 15,
      winRow: 20,
      winWidth: 80,
    };
  }

  async #switchBuffer(denops: Denops, params: Params, newCwd: string) {
    await denops.call("ddt#ui#terminal#_split", params);

    await denops.cmd(`buffer ${this.#bufNr}`);

    // Check current directory
    const cwd = await this.#getCwd(denops, params.promptPattern);
    if (cwd !== "" && newCwd !== cwd) {
      await this.#cd(denops, newCwd);
    }
  }

  async #newBuffer(denops: Denops, params: Params) {
    if (params.command.length === 0) {
      printError(denops, "command param must be set.");
      return;
    }

    await denops.call("ddt#ui#terminal#_split", params);

    const cwd = params.cwd === "" ? await fn.getcwd(denops) : params.cwd;

    if (denops.meta.host === "nvim") {
      // NOTE: ":terminal" replaces current buffer
      await denops.cmd("enew");

      // NOTE: termopen() is deprecated in Neovim 0.11+.
      if (await fn.has(denops, "nvim-0.11")) {
        await denops.call("jobstart", params.command, {
          ...params.extraTermOptions,
          term: true,
          cwd,
        });

        this.#jobid = await nvimOp.channel.getLocal(denops);
        this.#pid = await denops.call("jobpid", this.#jobid) as number;
      } else {
        await denops.call("termopen", params.command, {
          ...params.extraTermOptions,
          cwd,
        });

        this.#jobid = await vars.b.get(denops, "terminal_job_id");
        this.#pid = await vars.b.get(denops, "terminal_job_pid");
      }
    } else {
      this.#pid = await denops.call("term_start", params.command, {
        ...params.extraTermOptions,
        curwin: true,
        cwd,
        term_kill: "kill",
      }) as number;
    }

    this.#bufNr = await fn.bufnr(denops, "%");

    if (denops.meta.host === "nvim") {
      if (params.startInsert) {
        await denops.cmd("startinsert");
      } else {
        await stopInsert(denops);
      }
    } else {
      // In Vim8, must be insert mode to redraw
      await denops.cmd("startinsert");
    }

    await this.#initOptions(denops);
  }

  async #winId(denops: Denops): Promise<number> {
    const winIds = await fn.win_findbuf(denops, this.#bufNr) as number[];
    return winIds.length > 0 ? winIds[0] : -1;
  }

  async #initOptions(denops: Denops) {
    const winid = await this.#winId(denops);
    const existsSmoothScroll = await fn.exists(denops, "+smoothscroll");
    const existsStatusColumn = await fn.exists(denops, "+statuscolumn");

    await batch(denops, async (denops: Denops) => {
      // Set options
      await fn.setwinvar(denops, winid, "&list", 0);
      await fn.setwinvar(denops, winid, "&foldenable", 0);
      await fn.setwinvar(denops, winid, "&number", 0);
      await fn.setwinvar(denops, winid, "&relativenumber", 0);
      await fn.setwinvar(denops, winid, "&spell", 0);
      await fn.setwinvar(denops, winid, "&wrap", 0);
      await fn.setwinvar(denops, winid, "&colorcolumn", "");
      await fn.setwinvar(denops, winid, "&foldcolumn", 0);
      await fn.setwinvar(denops, winid, "&signcolumn", "no");
      if (existsStatusColumn) {
        await fn.setwinvar(denops, winid, "&statuscolumn", "");
      }
      if (existsSmoothScroll) {
        // NOTE: If smoothscroll is set in neovim, freezed in terminal buffer.
        await fn.setwinvar(denops, winid, "&smoothscroll", false);
      }

      await fn.setbufvar(denops, this.#bufNr, "&bufhidden", "hide");
      await fn.setbufvar(denops, this.#bufNr, "&swapfile", 0);
    });

    // NOTE: "setfiletype" must be the last
    // NOTE: Execute "setfiletype" twice to call after ftplugin in Vim.
    await fn.setbufvar(denops, this.#bufNr, "&filetype", "ddt-terminal");
    await fn.setbufvar(denops, this.#bufNr, "&filetype", "ddt-terminal");
  }

  async #initVariables(denops: Denops, name: string, cwd: string) {
    // Fetch win_getid before batch: inside batch the denops dispatcher queues
    // calls without returning actual values, so any await here would yield
    // undefined rather than the real window ID.
    const winid = await fn.win_getid(denops);

    // Batch setting variables to reduce RPCs
    await batch(denops, async (denops: Denops) => {
      await vars.b.set(denops, "ddt_ui_name", name);
      await vars.t.set(denops, "ddt_ui_last_bufnr", this.#bufNr);
      await vars.t.set(denops, "ddt_ui_last_directory", cwd);
      await vars.t.set(denops, "ddt_ui_terminal_last_name", name);
      await vars.g.set(denops, "ddt_ui_last_winid", winid);
    });
  }

  async #getCwd(denops: Denops, promptPattern: string): Promise<string> {
    const commandLine = await getCommandLine(
      denops,
      promptPattern,
      "$",
    );
    return await denops.call(
      "ddt#ui#terminal#_get_cwd",
      this.#pid,
      commandLine,
    ) as string;
  }

  async #cd(denops: Denops, directory: string) {
    const stat = await safeStat(directory);
    if (!stat || !stat.isDirectory) {
      return;
    }

    const quote = await fn.has(denops, "win32") ? '"' : "'";
    const cleanup = await fn.has(denops, "win32") ? "" : rawString`\<C-u>`;
    await jobSendString(
      denops,
      this.#bufNr,
      this.#jobid,
      rawString`${cleanup}cd ${quote}${directory}${quote}\<CR>`,
    );

    await termRedraw(denops, this.#bufNr);

    await vars.t.set(
      denops,
      "ddt_ui_last_directory",
      directory,
    );
  }
}

async function stopInsert(denops: Denops) {
  await useEval(denops, async (denops: Denops) => {
    if (denops.meta.host === "nvim") {
      await denops.cmd("stopinsert");
    } else {
      await denops.cmd("sleep 50m");
      await fn.feedkeys(denops, rawString`\<C-\>\<C-n>`, "n");
    }
  });
}

async function searchPrompt(
  denops: Denops,
  promptPattern: string,
  flags: string,
) {
  await fn.cursor(denops, 0, 1);
  const pattern = `^\\%(${promptPattern}\\m\\).\\?`;
  const pos = await fn.searchpos(denops, pattern, flags) as number[];
  if (pos[0] == 0) {
    return;
  }

  const col = await fn.matchend(
    denops,
    await fn.getline(denops, pos[0]),
    pattern,
  );
  await fn.cursor(
    denops,
    pos[0],
    col,
  );
}

async function getCommandLine(
  denops: Denops,
  promptPattern: string,
  lineNr: string | number = ".",
) {
  const currentLine = await fn.getline(denops, lineNr);
  return await fn.substitute(denops, currentLine, promptPattern, "", "");
}

async function jobSendString(
  denops: Denops,
  bufNr: number,
  jobid: number,
  keys: RawString,
) {
  // Use single eval to minimize RPCs and avoid blocking term_wait in Vim8 path.
  await useEval(denops, async (denops: Denops) => {
    if (denops.meta.host === "nvim") {
      await denops.call("chansend", jobid, keys);
    } else {
      await denops.call("term_sendkeys", bufNr, keys);
      // Do a lightweight redraw instead of blocking term_wait + redraw sequence.
      await denops.cmd("redraw");
    }
  });
}

async function termRedraw(
  denops: Denops,
  bufNr: number,
) {
  // Neovim performs efficient redraws natively; keep it immediate for best
  // responsiveness and unchanged behaviour.
  if (denops.meta.host === "nvim") {
    await doTermRedraw(denops, bufNr);
    return;
  }

  // Vim8: debounce redraws so that rapid successive calls (e.g. sending
  // multiple lines within a short burst) result in only a single redraw,
  // preventing UI stalls.  Clear any already-pending timer, then schedule
  // a fresh one; only the last call within the window actually redraws.
  const existing = termRedrawTimers.get(bufNr);
  if (existing !== undefined) {
    clearTimeout(existing);
  }
  const timerId = setTimeout(async () => {
    termRedrawTimers.delete(bufNr);
    try {
      await doTermRedraw(denops, bufNr);
    } catch {
      // Ignore errors from deferred redraws (e.g. buffer closed between
      // scheduling and execution); doTermRedraw already guards against
      // missing windows via win_findbuf.
    }
  }, TERM_REDRAW_DEBOUNCE_DELAY) as unknown as number;
  termRedrawTimers.set(bufNr, timerId);
}

async function doTermRedraw(
  denops: Denops,
  bufNr: number,
) {
  // Wrap whole sequence in useEval to reduce roundtrips.
  await useEval(denops, async (denops: Denops) => {
    if (denops.meta.host === "nvim") {
      await denops.cmd("redraw");
      return;
    }

    const ids = await fn.win_findbuf(denops, bufNr);
    if (ids.length === 0) {
      return;
    }

    const prevWinId = await fn.win_getid(denops);

    await fn.win_gotoid(denops, ids[0]);

    // Goto insert mode
    await denops.cmd("redraw");
    await denops.cmd("silent! normal! A");

    // Go back to normal mode (Vim8 path only; feedkeys is needed here)
    await denops.cmd("sleep 50m");
    await fn.feedkeys(denops, rawString`\<C-\>\<C-n>`, "n");

    await fn.win_gotoid(denops, prevWinId);
  });
}

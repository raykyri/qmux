import type { Dispatch, SetStateAction } from "react";
import { LoaderCircle, X } from "lucide-react";
import { Button, Dialog, DialogRoot, DialogTitle, Input } from "./ui";
import type { RepositoryBrowserState } from "./repositoryDialogs.types";
import type { RepositoryBranch } from "../types";

type Props = {
  repositoryBrowser: RepositoryBrowserState;
  setRepositoryBrowser: Dispatch<SetStateAction<RepositoryBrowserState | null>>;
  openInventoryWorktree: (path: string) => Promise<void>;
  openInventoryBranch: (branch: RepositoryBranch) => Promise<void>;
  formatPaneDir: (path: string) => string;
};

export default function RepositoryBrowserDialog({
  repositoryBrowser,
  setRepositoryBrowser,
  openInventoryWorktree,
  openInventoryBranch,
  formatPaneDir,
}: Props) {
  return (
    <DialogRoot
      onDismiss={() => setRepositoryBrowser(null)}
      dismissDisabled={Boolean(repositoryBrowser.opening)}
    >
      <Dialog
        className="repository-browser-dialog"
        aria-labelledby="repository-browser-title"
      >
        <div className="repository-browser-header">
          <div>
            <DialogTitle id="repository-browser-title">
              Branches and worktrees
            </DialogTitle>
            {repositoryBrowser.inventory ? (
              <p title={repositoryBrowser.inventory.repositoryRoot}>
                {formatPaneDir(repositoryBrowser.inventory.repositoryRoot)}
              </p>
            ) : null}
          </div>
          <Button
            disabled={Boolean(repositoryBrowser.opening)}
            onClick={() => setRepositoryBrowser(null)}
            aria-label="Close branches and worktrees"
          >
            <X size={14} aria-hidden="true" />
          </Button>
        </div>
        {!repositoryBrowser.inventory && !repositoryBrowser.error ? (
          <p className="repository-browser-loading">
            <LoaderCircle
              className="confirm-dialog-action-spinner"
              size={14}
              aria-hidden="true"
            />{" "}
            Loading repository…
          </p>
        ) : null}
        {repositoryBrowser.error ? (
          <p className="confirm-dialog-error" role="alert">
            {repositoryBrowser.error}
          </p>
        ) : null}
        {repositoryBrowser.inventory ? (
          <div className="repository-browser-content">
            <section>
              <h3>Worktrees</h3>
              <div className="repository-browser-list">
                {repositoryBrowser.inventory.worktrees.map((worktree) => (
                  <div className="repository-browser-row" key={worktree.path}>
                    <div className="repository-browser-row-copy">
                      <strong>{worktree.branch ?? "Detached HEAD"}</strong>
                      <span title={worktree.path}>
                        {formatPaneDir(worktree.path)}
                      </span>
                    </div>
                    <Button
                      className="control-button"
                      type="button"
                      disabled={
                        Boolean(repositoryBrowser.opening) || worktree.prunable
                      }
                      onClick={() => void openInventoryWorktree(worktree.path)}
                    >
                      {repositoryBrowser.opening === worktree.path
                        ? "Opening…"
                        : "Open"}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
            <section>
              <h3>Branches</h3>
              <div className="repository-browser-list">
                {repositoryBrowser.inventory.branches.map((branch) => (
                  <div className="repository-browser-row" key={branch.fullRef}>
                    <div className="repository-browser-row-copy">
                      <strong>{branch.name}</strong>
                      <span>
                        {branch.remote
                          ? "Remote branch"
                          : branch.checkedOutPath
                            ? `Checked out at ${formatPaneDir(branch.checkedOutPath)}`
                            : branch.upstream
                              ? `Tracks ${branch.upstream.replace(/^refs\/remotes\//, "")}`
                              : "Local branch"}
                      </span>
                    </div>
                    {!branch.checkedOutPath ? (
                      <Input
                        className="repository-browser-name"
                        aria-label={`Worktree name for ${branch.name}`}
                        value={repositoryBrowser.names[branch.fullRef] ?? ""}
                        disabled={Boolean(repositoryBrowser.opening)}
                        maxLength={240}
                        spellCheck={false}
                        onChange={(event) => {
                          const name = event.currentTarget.value;
                          setRepositoryBrowser((current) =>
                            current
                              ? {
                                  ...current,
                                  names: {
                                    ...current.names,
                                    [branch.fullRef]: name,
                                  },
                                }
                              : current,
                          );
                        }}
                      />
                    ) : null}
                    <Button
                      className="control-button"
                      type="button"
                      disabled={
                        Boolean(repositoryBrowser.opening) ||
                        (!branch.checkedOutPath &&
                          !repositoryBrowser.names[branch.fullRef]?.trim())
                      }
                      onClick={() => void openInventoryBranch(branch)}
                    >
                      {repositoryBrowser.opening === branch.fullRef
                        ? "Opening…"
                        : "Open"}
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          </div>
        ) : null}
      </Dialog>
    </DialogRoot>
  );
}

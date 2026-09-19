import { Bookmark } from "lucide-react";

import { Button, classNames } from "../ui";

/** Follow and Bookmark controls for one research thread. Both flags persist
 * on the tree, so Home cards and the open thread render the same pair from
 * the same state. */
export default function ResearchThreadActions({
  followed,
  bookmarked,
  disabled = false,
  onToggleFollow,
  onToggleBookmark,
}: {
  followed: boolean;
  bookmarked: boolean;
  disabled?: boolean;
  onToggleFollow: () => void;
  onToggleBookmark: () => void;
}) {
  return (
    <div className="research-thread-actions">
      <Button
        variant="link"
        className={classNames(
          "research-thread-action",
          "research-thread-follow",
          followed && "is-active",
        )}
        aria-pressed={followed}
        disabled={disabled}
        title={followed ? "Stop following this thread" : "Follow this thread"}
        onClick={onToggleFollow}
      >
        {followed ? "Following" : "Follow"}
      </Button>
      <Button
        variant="icon"
        className={classNames(
          "research-thread-action",
          "research-thread-bookmark",
          bookmarked && "is-active",
        )}
        aria-pressed={bookmarked}
        aria-label={bookmarked ? "Remove bookmark" : "Bookmark"}
        disabled={disabled}
        title={bookmarked ? "Remove bookmark" : "Bookmark this thread"}
        onClick={onToggleBookmark}
      >
        <Bookmark size={13} aria-hidden="true" fill={bookmarked ? "currentColor" : "none"} />
      </Button>
    </div>
  );
}

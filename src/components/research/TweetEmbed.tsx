import { useState } from "react";
import type { MouseEvent } from "react";
import { Play } from "lucide-react";
import { openExternalUrl } from "../../lib/api";
import type {
  QuotedTweetSnapshot,
  TweetSnapshot,
  TweetTextRun,
} from "../../lib/journalTweets";

function externalLinkClick(url: string) {
  return (event: MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    void openExternalUrl(url);
  };
}

// Fallback for snapshots with no avatar URL: an initial on a colored disc,
// where the hue is derived from the handle so it is stable across renders and
// distinct between authors. (Avatar URLs that fail to load are handled
// separately, via onError.)
function avatarFallback(name: string, handle: string) {
  const seed = handle || name;
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return {
    initial: [...(name || seed)][0]?.toUpperCase() ?? "?",
    color: `hsl(${hash % 360} 55% 45%)`,
  };
}

function TweetAvatar({
  name,
  handle,
  avatarUrl,
  size,
}: {
  name: string;
  handle: string;
  avatarUrl?: string;
  size: number;
}) {
  // A snapshot's avatar URL can go stale (profile changed, image deleted);
  // a failed load falls back to the initial disc instead of a broken image.
  const [failed, setFailed] = useState(false);
  if (avatarUrl && !failed) {
    return (
      <img
        className="journal-tweet-avatar"
        src={avatarUrl}
        width={size}
        height={size}
        alt=""
        aria-hidden="true"
        draggable={false}
        onError={() => setFailed(true)}
      />
    );
  }
  const fallback = avatarFallback(name, handle);
  return (
    <span
      className="journal-tweet-avatar journal-tweet-avatar-fallback"
      style={{ width: size, height: size, background: fallback.color }}
      aria-hidden="true"
    >
      {fallback.initial}
    </span>
  );
}

function TweetText({ runs, className }: { runs: TweetTextRun[]; className: string }) {
  if (runs.length === 0) {
    return null;
  }
  return (
    <p className={className}>
      {runs.map((run, index) =>
        run.kind === "link" && run.url ? (
          <a key={index} href={run.url} onClick={externalLinkClick(run.url)}>
            {run.text}
          </a>
        ) : (
          <span key={index}>{run.text}</span>
        ),
      )}
    </p>
  );
}

function TweetMediaStrip({
  media,
  compact,
  sensitive,
}: {
  media: QuotedTweetSnapshot["media"];
  compact?: boolean;
  sensitive?: boolean;
}) {
  const [revealed, setRevealed] = useState(!sensitive);
  if (media.length === 0) {
    return null;
  }
  return (
    <div
      className={`journal-tweet-media${media.length > 1 ? " is-multi" : ""}${
        compact ? " is-compact" : ""
      }${sensitive && !revealed ? " is-sensitive" : ""}`}
    >
      {media.map((item, index) => {
        // Known dimensions reserve the media box before (or without) the
        // image, so the feed doesn't reflow as media arrives.
        const aspect =
          item.width && item.height
            ? { aspectRatio: `${item.width} / ${item.height}` }
            : undefined;
        const image = (
          <img
            src={item.imageUrl}
            alt={item.altText ?? (item.kind === "photo" ? "Photo" : "Video thumbnail")}
            loading="lazy"
            draggable={false}
            style={aspect}
          />
        );
        if (item.kind === "photo") {
          return (
            <span key={index} className="journal-tweet-media-item">
              {image}
            </span>
          );
        }
        const watchUrl = item.watchUrl;
        return (
          <a
            key={index}
            className="journal-tweet-media-item journal-tweet-video"
            href={watchUrl}
            title={item.kind === "gif" ? "Watch GIF on X" : "Watch video on X"}
            onClick={watchUrl ? externalLinkClick(watchUrl) : (e) => e.preventDefault()}
          >
            {image}
            <span className="journal-tweet-play" aria-hidden="true">
              <Play size={compact ? 14 : 18} fill="currentColor" />
            </span>
          </a>
        );
      })}
      {sensitive && !revealed ? (
        <button
          type="button"
          className="journal-tweet-sensitive-reveal"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setRevealed(true);
          }}
        >
          Show sensitive media
        </button>
      ) : null}
    </div>
  );
}

/** The timeline's age stamp: "29m" and "5h" inside a day, "Jul 27" inside the
 * year, "Mar 21, 2006" beyond it. */
function formatTweetAge(iso: string | undefined, now = Date.now()): string | null {
  if (!iso) {
    return null;
  }
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  const seconds = Math.max(0, Math.round((now - parsed.getTime()) / 1000));
  if (seconds < 60) {
    return `${seconds}s`;
  }
  if (seconds < 3600) {
    return `${Math.floor(seconds / 60)}m`;
  }
  if (seconds < 86_400) {
    return `${Math.floor(seconds / 3600)}h`;
  }
  const sameYear = parsed.getFullYear() === new Date(now).getFullYear();
  return parsed.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** The full stamp behind the age, for the title tooltip. */
function formatTweetDate(iso: string | undefined): string | null {
  if (!iso) {
    return null;
  }
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toLocaleString();
}

/** Engagement counts the way a timeline abbreviates them: exact under ten
 * thousand, whole thousands past it, one decimal past a million. */
function formatTweetCount(value: number): string {
  if (value < 10_000) {
    return value.toLocaleString();
  }
  if (value < 1_000_000) {
    return `${Math.floor(value / 1000)}K`;
  }
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

function ReplyGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  );
}

function LikeGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z" />
    </svg>
  );
}

function VerifiedBadge() {
  return (
    <svg
      className="journal-tweet-verified"
      viewBox="0 0 22 22"
      fill="currentColor"
      aria-label="Verified"
      role="img"
    >
      <path d="M20.396 11c-.018-.646-.215-1.275-.57-1.816-.354-.54-.852-.972-1.438-1.246.223-.607.27-1.264.14-1.897-.131-.634-.437-1.218-.882-1.687-.47-.445-1.053-.75-1.687-.882-.633-.13-1.29-.083-1.897.14-.273-.587-.704-1.086-1.245-1.44S11.647 1.62 11 1.604c-.646.017-1.273.213-1.813.568s-.969.854-1.24 1.44c-.608-.223-1.267-.272-1.902-.14-.635.13-1.22.436-1.69.882-.445.47-.749 1.055-.878 1.688-.13.633-.08 1.29.144 1.896-.587.274-1.087.705-1.443 1.245-.356.54-.555 1.17-.574 1.817.02.647.218 1.276.574 1.816.356.54.856.972 1.443 1.245-.224.606-.274 1.263-.144 1.896.13.634.433 1.218.877 1.688.47.443 1.054.747 1.687.878.633.132 1.29.084 1.897-.136.274.586.705 1.084 1.246 1.439.54.354 1.17.551 1.816.569.647-.016 1.276-.213 1.817-.567s.972-.854 1.245-1.44c.604.239 1.266.296 1.903.164.636-.132 1.22-.447 1.68-.907.46-.46.776-1.044.908-1.681s.075-1.299-.165-1.903c.586-.274 1.084-.705 1.439-1.246.354-.54.551-1.17.569-1.816zM9.662 14.85l-3.429-3.428 1.293-1.302 2.072 2.072 4.4-4.794 1.347 1.246z" />
    </svg>
  );
}

function TweetLinkCardView({ card }: { card: NonNullable<TweetSnapshot["card"]> }) {
  return (
    <a
      className={`journal-tweet-card${card.large ? " is-large" : ""}`}
      href={card.url}
      onClick={externalLinkClick(card.url)}
    >
      {card.imageUrl ? (
        <span className="journal-tweet-card-media">
          <img src={card.imageUrl} alt="" loading="lazy" draggable={false} />
        </span>
      ) : null}
      <span className="journal-tweet-card-copy">
        <span className="journal-tweet-card-domain">{card.domain}</span>
        <span className="journal-tweet-card-title">{card.title}</span>
        {card.description ? (
          <span className="journal-tweet-card-desc">{card.description}</span>
        ) : null}
      </span>
    </a>
  );
}

/** A captured tweet rendered as an X-embed look (header, text, media, quote,
 * linked timestamp) with no wrapper chrome of its own, so a Home feed entry
 * reads as a tweet rather than a tweet inside a content item and a research
 * message can drop the same card under its prompt. The whole card is a link
 * to the post; descendant links and controls keep their own destinations. */
export function TweetEmbed({ tweet }: { tweet: TweetSnapshot }) {
  const quoted = tweet.quoted;
  const authorUrl = `https://x.com/${tweet.author.handle}`;
  const age = formatTweetAge(tweet.createdAt);
  return (
    <article
      className="journal-tweet"
      aria-label={`Open tweet by @${tweet.author.handle}`}
      role="link"
      tabIndex={0}
      onClick={(event) => {
        // Descendant links and controls prevent their handled click from
        // reaching here. Everything else on the embed opens this tweet.
        if (event.defaultPrevented) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void openExternalUrl(tweet.url);
      }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.key !== "Enter") {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        void openExternalUrl(tweet.url);
      }}
    >
      <a
        className="journal-tweet-avatar-link"
        href={authorUrl}
        aria-hidden="true"
        tabIndex={-1}
        onClick={externalLinkClick(authorUrl)}
      >
        <TweetAvatar
          name={tweet.author.name}
          handle={tweet.author.handle}
          avatarUrl={tweet.author.avatarUrl}
          size={40}
        />
      </a>
      <div className="journal-tweet-main">
        <div className="journal-tweet-head">
          <a
            className="journal-tweet-who"
            href={authorUrl}
            onClick={externalLinkClick(authorUrl)}
          >
            <span className="journal-tweet-author">{tweet.author.name}</span>
            {tweet.author.verified ? <VerifiedBadge /> : null}
            <span className="journal-tweet-handle">@{tweet.author.handle}</span>
          </a>
          {age ? (
            <>
              <span className="journal-tweet-dot" aria-hidden="true">
                ·
              </span>
              <a
                className="journal-tweet-age"
                href={tweet.url}
                title={formatTweetDate(tweet.createdAt) ?? undefined}
                onClick={externalLinkClick(tweet.url)}
              >
                {age}
              </a>
            </>
          ) : null}
        </div>
        {tweet.replyTo ? (
          <p className="journal-tweet-reply">
            Replying to <span>@{tweet.replyTo.handle}</span>
          </p>
        ) : null}
        <TweetText runs={tweet.runs} className="journal-tweet-text" />
        {tweet.partial ? (
          <a
            className="journal-tweet-more"
            href={tweet.url}
            onClick={externalLinkClick(tweet.url)}
          >
            Show more
          </a>
        ) : null}
        <TweetMediaStrip media={tweet.media} sensitive={tweet.possiblySensitive} />
        {tweet.card ? <TweetLinkCardView card={tweet.card} /> : null}
        {quoted ? (
          <div
            className="journal-tweet-quote"
            role="link"
            tabIndex={0}
            onClick={(event) => {
              event.stopPropagation();
              // Links inside the quoted text keep their own targets.
              if ((event.target as HTMLElement).closest("a")) {
                return;
              }
              void openExternalUrl(quoted.url);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                void openExternalUrl(quoted.url);
              }
            }}
          >
            <div className="journal-tweet-quote-head">
              <TweetAvatar
                name={quoted.author.name}
                handle={quoted.author.handle}
                avatarUrl={quoted.author.avatarUrl}
                size={18}
              />
              <span className="journal-tweet-author">{quoted.author.name}</span>
              {quoted.author.verified ? <VerifiedBadge /> : null}
              <span className="journal-tweet-handle">@{quoted.author.handle}</span>
            </div>
            <TweetText runs={quoted.runs} className="journal-tweet-text is-quote" />
            {quoted.partial ? (
              <span className="journal-tweet-more">Show more</span>
            ) : null}
            <TweetMediaStrip
              media={quoted.media}
              compact
              sensitive={quoted.possiblySensitive}
            />
            {quoted.card ? <TweetLinkCardView card={quoted.card} /> : null}
          </div>
        ) : null}
        {tweet.replies !== undefined || tweet.likes !== undefined ? (
          // Counts as captured, not controls: this is a journal entry, so the
          // engagement reads as metadata and nothing here acts on X.
          <div className="journal-tweet-stats">
            {tweet.replies !== undefined ? (
              <span className="journal-tweet-stat" title={`${tweet.replies} replies`}>
                <ReplyGlyph />
                {formatTweetCount(tweet.replies)}
              </span>
            ) : null}
            {tweet.likes !== undefined ? (
              <span className="journal-tweet-stat" title={`${tweet.likes} likes`}>
                <LikeGlyph />
                {formatTweetCount(tweet.likes)}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

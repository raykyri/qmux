import { CircleAlert, LoaderCircle } from "lucide-react";
import type { EncyclopediaPageSummary } from "../../types";
import { Button } from "../ui";

interface EncyclopediaSidebarSectionProps {
  pages: EncyclopediaPageSummary[];
  /** Slug of the page the stage currently shows, or null. */
  activeSlug: string | null;
  onOpen: (slug: string) => void;
}

/** Sidebar list of the scoped workspace's encyclopedia pages, alphabetical by
 * title. Hidden until the first page exists, since pages only come from
 * clicking wikilinks. Rows reuse the research row recipe so the section reads
 * as part of the same list. */
export default function EncyclopediaSidebarSection({
  pages,
  activeSlug,
  onOpen,
}: EncyclopediaSidebarSectionProps) {
  if (pages.length === 0) {
    return null;
  }
  return (
    <section
      className="research-sidebar-section encyclopedia-sidebar-section"
      aria-label="Encyclopedia"
    >
      <div className="research-sidebar-heading">
        <span>Encyclopedia</span>
        <span className="research-sidebar-folder-count">{pages.length}</span>
      </div>
      <div className="encyclopedia-sidebar-rows" role="list">
        {pages.map((page) => {
          const selected = page.slug === activeSlug;
          return (
            <div
              key={page.slug}
              role="listitem"
              className={`research-sidebar-row encyclopedia-sidebar-row${
                selected ? " is-selected" : ""
              }`}
            >
              <Button
                className="research-sidebar-select"
                aria-current={selected ? "page" : undefined}
                title={page.status === "failed" ? `${page.title} (generation failed)` : page.title}
                onClick={() => onOpen(page.slug)}
              >
                <span className="research-sidebar-copy">
                  <span className="research-sidebar-title">
                    <span className="research-sidebar-title-text">{page.title}</span>
                  </span>
                </span>
                {page.status === "generating" ? (
                  <span className="research-sidebar-spinner" title="Writing page">
                    <LoaderCircle size={14} aria-hidden="true" />
                  </span>
                ) : page.status === "failed" ? (
                  <span className="encyclopedia-sidebar-failed" title="Generation failed">
                    <CircleAlert size={14} aria-hidden="true" />
                  </span>
                ) : null}
              </Button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

import { forwardRef, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  BookOpen,
  Bot,
  CodeXml,
  Contrast,
  FlaskConical,
  Globe,
  Search,
  SlidersHorizontal,
  SquareTerminal,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Input, classNames } from "../ui";
import type { SettingsStatusTone } from "../ui";

export type SettingsSectionId =
  | "general"
  | "workspace"
  | "research"
  | "agents"
  | "remotes"
  | "appearance"
  | "terminal"
  | "advanced";

export interface SettingsSectionInfo {
  id: SettingsSectionId;
  label: string;
  description: string;
  icon: LucideIcon;
}

export const SETTINGS_SECTIONS: readonly SettingsSectionInfo[] = [
  {
    id: "general",
    label: "General",
    description: "Global shortcuts, system behavior, and alerts.",
    icon: SlidersHorizontal,
  },
  {
    id: "workspace",
    label: "Workspace",
    description: "Code mode, worktrees, transcripts, and tab titles.",
    icon: CodeXml,
  },
  {
    id: "research",
    label: "Research",
    description: "Default research settings.",
    icon: BookOpen,
  },
  {
    id: "agents",
    label: "Agents",
    description: "Agent CLIs qmux can launch on this Mac.",
    icon: Bot,
  },
  {
    id: "remotes",
    label: "Remotes",
    description: "Remote machines for SSH tabs.",
    icon: Globe,
  },
  {
    id: "appearance",
    label: "Appearance",
    description: "Theme, interface font, and motion.",
    icon: Contrast,
  },
  {
    id: "terminal",
    label: "Terminal",
    description: "Terminal appearance, scrolling, copy, and paste.",
    icon: SquareTerminal,
  },
  {
    id: "advanced",
    label: "Advanced",
    description: "Diagnostics.",
    icon: FlaskConical,
  },
];

/** Sidebar groups separated by a small gap. */
const NAV_GROUPS: readonly (readonly SettingsSectionId[])[] = [
  ["general", "workspace", "research"],
  ["agents", "remotes"],
  ["appearance", "terminal"],
  ["advanced"],
];

const SECTION_BY_ID = new Map(SETTINGS_SECTIONS.map((section) => [section.id, section]));

export function settingsSectionInfo(id: SettingsSectionId): SettingsSectionInfo {
  return SECTION_BY_ID.get(id) ?? SETTINGS_SECTIONS[0];
}

export function settingsTabId(id: SettingsSectionId) {
  return `settings-tab-${id}`;
}

export const SETTINGS_PAGE_ID = "settings-page";

export interface SettingsSidebarProps {
  section: SettingsSectionId;
  /** While searching, no section is selected; results span every section. */
  searching: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onSectionChange: (section: SettingsSectionId) => void;
  /** Sections that need the user's attention get a status dot. */
  attention: Partial<Record<SettingsSectionId, Exclude<SettingsStatusTone, "ok" | "neutral">>>;
}

export const SettingsSidebar = forwardRef<HTMLInputElement, SettingsSidebarProps>(
  function SettingsSidebar(
    { section, searching, query, onQueryChange, onSectionChange, attention },
    searchRef,
  ) {
    const tabRefs = useRef(new Map<SettingsSectionId, HTMLButtonElement>());
    const order = NAV_GROUPS.flat();

    function moveFocus(event: ReactKeyboardEvent<HTMLButtonElement>, id: SettingsSectionId) {
      const index = order.indexOf(id);
      let next: number;
      if (event.key === "ArrowDown") {
        next = (index + 1) % order.length;
      } else if (event.key === "ArrowUp") {
        next = (index - 1 + order.length) % order.length;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = order.length - 1;
      } else {
        return;
      }
      event.preventDefault();
      const nextId = order[next];
      onSectionChange(nextId);
      tabRefs.current.get(nextId)?.focus();
    }

    return (
      <aside className="settings-sidebar">
        <div className="settings-search">
          <Search size={14} className="settings-search-icon" aria-hidden="true" />
          <Input
            ref={searchRef}
            type="search"
            className="settings-search-input"
            placeholder="Search settings"
            aria-label="Search settings"
            aria-controls={SETTINGS_PAGE_ID}
            spellCheck={false}
            autoComplete="off"
            value={query}
            onChange={(event) => onQueryChange(event.currentTarget.value)}
          />
          {query ? (
            <button
              type="button"
              className="settings-search-clear"
              aria-label="Clear search"
              onClick={() => {
                onQueryChange("");
                if (searchRef && typeof searchRef !== "function") {
                  searchRef.current?.focus();
                }
              }}
            >
              <X size={13} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        <nav
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings sections"
        >
          {NAV_GROUPS.map((group, groupIndex) => (
            <div className="settings-nav-group" role="presentation" key={groupIndex}>
              {group.map((id) => {
                const info = settingsSectionInfo(id);
                const Icon = info.icon;
                const selected = !searching && id === section;
                const tone = attention[id];
                return (
                  <button
                    key={id}
                    ref={(node) => {
                      if (node) {
                        tabRefs.current.set(id, node);
                      } else {
                        tabRefs.current.delete(id);
                      }
                    }}
                    id={settingsTabId(id)}
                    type="button"
                    role="tab"
                    aria-selected={selected}
                    aria-controls={SETTINGS_PAGE_ID}
                    tabIndex={id === section ? 0 : -1}
                    className={classNames("settings-nav-item", selected && "is-selected")}
                    onClick={() => onSectionChange(id)}
                    onKeyDown={(event) => moveFocus(event, id)}
                  >
                    <Icon size={15} aria-hidden="true" />
                    <span>{info.label}</span>
                    {tone ? (
                      <span
                        className={`settings-nav-dot is-${tone}`}
                        role="img"
                        aria-label="Needs attention"
                      />
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
    );
  },
);

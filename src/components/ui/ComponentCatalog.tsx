import { useLayoutEffect, useState } from "react";
import {
  Button,
  Dialog,
  DialogActions,
  DialogRoot,
  DialogTitle,
  Input,
  Menu,
  MenuItem,
  NativeSelect,
  Select,
  Textarea,
} from "./index";
import { LauncherSelect } from "../LauncherSelect";
import { APPEARANCE_OPTIONS, COLOR_THEME_OPTIONS } from "../../lib/settings";
import type { Appearance, ColorTheme } from "../../lib/settings";

const sectionStyle = {
  display: "grid",
  gap: 12,
  padding: 16,
  border: "1px solid var(--surface-divider)",
  borderRadius: "var(--radius-lg)",
  background: "var(--panel-bg)",
};

export default function ComponentCatalog() {
  const [selectValue, setSelectValue] = useState("current");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [launcherModel, setLauncherModel] = useState("fable");
  const [launcherEffort, setLauncherEffort] = useState("medium");
  // The catalog renders instead of <App/>, so nothing else sets the root
  // attributes the tokens key off. Drive them here so every component can be
  // reviewed in both appearances and both color themes.
  const [appearance, setAppearance] = useState<Appearance>("dark");
  const [colorTheme, setColorTheme] = useState<ColorTheme>("green-blob");
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.appearance = appearance;
    root.dataset.colorTheme = colorTheme;
  }, [appearance, colorTheme]);
  return (
    <main
      style={{
        minHeight: "100vh",
        padding: 24,
        background: "var(--workspace-bg)",
        color: "var(--text-primary)",
        fontFamily: "var(--font-ui)",
      }}
    >
      <div style={{ display: "grid", gap: 18, width: "min(760px, 100%)", margin: "0 auto" }}>
        <h1 style={{ margin: 0 }}>qmux UI components</h1>
        <section style={sectionStyle}>
          <h2 style={{ margin: 0 }}>Appearance</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <NativeSelect
              aria-label="Appearance"
              value={appearance}
              onChange={(event) => setAppearance(event.currentTarget.value as Appearance)}
            >
              {APPEARANCE_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
            <NativeSelect
              aria-label="Color theme"
              value={colorTheme}
              onChange={(event) => setColorTheme(event.currentTarget.value as ColorTheme)}
            >
              {COLOR_THEME_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </NativeSelect>
          </div>
        </section>
        <section style={sectionStyle}>
          <h2 style={{ margin: 0 }}>Buttons</h2>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <Button>Default</Button>
            <Button tone="primary">Primary</Button>
            <Button tone="danger">Danger</Button>
            <Button disabled>Disabled</Button>
            <Button variant="icon" aria-label="Icon button">•••</Button>
            <Button variant="link">Link button</Button>
          </div>
        </section>
        <section style={sectionStyle}>
          <h2 style={{ margin: 0 }}>Fields</h2>
          <Input aria-label="Text input" defaultValue="Text input" />
          <Textarea aria-label="Textarea" defaultValue="Textarea" rows={3} />
          <NativeSelect aria-label="Native select" defaultValue="one">
            <option value="one">Native option one</option>
            <option value="two">Native option two</option>
          </NativeSelect>
          <Select
            ariaLabel="Custom select"
            value={selectValue}
            onChange={setSelectValue}
            options={[
              { value: "current", label: "Current commit (new branch)" },
              { value: "main", label: "main", group: "Local branches" },
              { value: "review", label: "review — checked out", group: "Local branches" },
              { value: "origin/main", label: "origin/main", group: "Remote branches" },
              { value: "loading", label: "Loading branches…", disabled: true },
            ]}
          />
          <Select ariaLabel="Disabled select" value="" options={[]} onChange={() => undefined} />
        </section>
        <section style={sectionStyle}>
          <h2 style={{ margin: 0 }}>Menu</h2>
          <Menu autoFocusFirst={false} style={{ position: "relative" }}>
            <MenuItem>Open</MenuItem>
            <MenuItem selected>Selected</MenuItem>
            <MenuItem tone="danger">Delete</MenuItem>
            <MenuItem disabled>Disabled</MenuItem>
          </Menu>
        </section>
        <section style={sectionStyle}>
          <h2 style={{ margin: 0 }}>Launcher select</h2>
          <p style={{ margin: 0, color: "var(--text-secondary)" }}>
            The closed trigger, and the same select with a submenu row: open it and press
            ArrowRight or Enter on “Effort” for the nested list, ArrowLeft or Escape to come back.
          </p>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            <LauncherSelect
              ariaLabel="Model"
              value={launcherModel}
              options={[
                { value: "fable", label: "Fable" },
                { value: "opus", label: "Opus" },
                { value: "sonnet", label: "Sonnet" },
                { value: "custom", label: "Custom", dividerBefore: true },
              ]}
              onChange={setLauncherModel}
              submenu={{
                label: "Effort",
                ariaLabel: "Reasoning effort",
                value: launcherEffort,
                options: [
                  { value: "low", label: "Low" },
                  { value: "medium", label: "Medium" },
                  { value: "high", label: "High" },
                ],
                onChange: setLauncherEffort,
              }}
            />
            <LauncherSelect
              ariaLabel="Disabled model"
              value={launcherModel}
              options={[{ value: "fable", label: "Fable" }]}
              onChange={setLauncherModel}
              disabled
            />
          </div>
        </section>
        <section style={sectionStyle}>
          <h2 style={{ margin: 0 }}>Dialog</h2>
          <Button onClick={() => setDialogOpen(true)}>Open dialog</Button>
        </section>
      </div>
      <DialogRoot open={dialogOpen} onDismiss={() => setDialogOpen(false)}>
        <Dialog aria-labelledby="catalog-dialog-title">
          <DialogTitle id="catalog-dialog-title">Example dialog</DialogTitle>
          <p>Tab focus remains inside this surface and returns to the trigger when closed.</p>
          <DialogActions>
            <Button onClick={() => setDialogOpen(false)}>Cancel</Button>
            <Button tone="primary" onClick={() => setDialogOpen(false)}>
              Confirm
            </Button>
          </DialogActions>
        </Dialog>
      </DialogRoot>
    </main>
  );
}

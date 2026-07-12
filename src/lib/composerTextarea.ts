export const COMPOSER_TEXTAREA_MAX_HEIGHT = 200;

export function growComposerTextarea(textarea: HTMLTextAreaElement) {
  textarea.style.height = "auto";
  textarea.style.height = `${Math.min(textarea.scrollHeight, COMPOSER_TEXTAREA_MAX_HEIGHT)}px`;
}

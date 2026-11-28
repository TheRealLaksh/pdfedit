/**
 * Wording of the start screen, the finish sheet, notices, hints and shortcuts, kept in one place so
 * it can be translated. The static copy in index.html (read by search engines before the app starts) repeats
 * the start screen: tests/e2e/shell.spec.ts fails when the two drift apart.
 */

export const START = {
  name: "PDFEdit",
  title: "Edit the text in any PDF",
  lead: "Tap a line, retype it, download. It keeps its font, size and place wherever the file allows.",
  choose: "Choose file",
  sample: "Try a sample",
  drop: "or drop it here.",
  accepts: "Opens PDFs and pictures.",
  privacy: "Processed on your device. Your file is never uploaded.",
  /** each is a way of saying "edit this line", shown in its own script */
  scripts: [
    { lang: "hi", dir: "ltr", text: "यह पंक्ति बदलें" },
    { lang: "ar", dir: "rtl", text: "عدّل هذا السطر" },
    { lang: "ta", dir: "ltr", text: "இந்த வரியைத் திருத்தவும்" },
    { lang: "bn", dir: "ltr", text: "এই লাইনটি বদলান" },
    { lang: "zh", dir: "ltr", text: "修改这一行" },
    { lang: "ru", dir: "ltr", text: "Измените эту строку" },
  ],
  stepsTitle: "How it works",
  steps: [
    { title: "Open", text: "Choose a PDF or a photo from your phone or computer." },
    { title: "Retype", text: "Tap any line and change it. Sign, fill forms, reorder pages or black things out." },
    { title: "Save or share", text: "Download the new copy, or send it straight from your phone." },
  ],
  moreTitle: "What it can do",
  more: [
    { title: "Many languages", text: "Hindi, Marathi, Bengali, Tamil, Telugu, Urdu, Arabic, Hebrew, Chinese, Japanese and more." },
    { title: "Scanned pages", text: "Text recognition runs in your browser, so photographed pages can be edited too." },
    { title: "Works offline", text: "After the first visit the editor opens without a connection." },
    { title: "On a phone", text: "Made for touch first, and just as complete on a computer." },
  ],
  questionsTitle: "Questions",
  questions: [
    {
      q: "Does the new text look like the old text?",
      a: "Unchanged letters keep their original shapes. New letters use the font inside the PDF when it has them, and the closest free font when it does not.",
    },
    { q: "Is it free? Is there a watermark?", a: "It is free, with no account, no page limit and no watermark." },
    {
      q: "Where does my file go?",
      a: "Nowhere. The editor runs in your browser and reads the file on your device. Fonts and text recognition data are downloaded when needed.",
    },
    {
      q: "What are the limits?",
      a: "Text does not reflow, so a longer line can run into what follows. On scans, changed words are covered, not erased.",
    },
    {
      q: "Can I edit a signed PDF?",
      a: "Yes, but the signature will no longer be valid, and PDFEdit says so. Only edit documents you are allowed to change.",
    },
  ],
  source: "Open source (AGPL)",
  author: "Built by Laksh Pradhwani",
} as const;

export const SAMPLE = { url: "/sample.pdf", name: "PDFEdit sample.pdf" } as const;

export const DRAFT = {
  heading: "Continue where you left off",
  resume: "Continue",
  remove: "Delete draft",
  removed: "The saved draft was deleted",
  kept: "Kept only on this device.",
  failed: "The draft could not be opened.",
  partly: (n: number) => `${n === 1 ? "One change" : `${n} changes`} could not be restored. Check the pages.`,
  setting: "Keep a draft of unsaved work",
  settingHint: "Saved on this device for 7 days, so a closed tab loses nothing. Never for protected files.",
  restoring: "Opening your draft",
} as const;

export const FINISH = {
  ready: "Your PDF is ready",
  saved: "Saved",
  nameLabel: "File name",
  share: "Share",
  save: "Save to device",
  saveAgain: "Save again",
  keep: "Keep editing",
  sizeTitle: "Make it smaller",
  sizeHint: "For upload forms with a size limit. Pictures are compressed, text stays sharp.",
  asIs: "As it is",
  custom: "Other",
  customLabel: "Largest size in KB",
  apply: "Apply",
  password: "Add a password",
  open: "Open another file",
  working: "Preparing your PDF",
  shrinking: "Making it smaller",
  shared: "Shared",
  shareFailed: "Sharing did not work. Save the file instead.",
  savedNotice: (name: string) => `Saved "${name}" to your downloads`,
  options: "Share or resize",
  reached: (size: string) => `Now ${size}, within the limit.`,
  missed: (size: string, target: string) =>
    `The smallest this file can get is ${size}, still over ${target}. Removing pages or pictures may help.`,
} as const;

export const NOTICE = {
  signed: "This PDF is digitally signed. Saving changes will break the signature.",
  repaired: "This file was damaged and has been repaired.",
  restricted: "The author restricted editing. Your copy won't carry that restriction. Edit it only if you're allowed to.",
  xfa: "Some fields in this form only appear in Adobe's software.",
  fallback: (fonts: string[]) =>
    `Some letters are not in this PDF's own font, so ${fonts.join(" and ")} ${fonts.length > 1 ? "were" : "was"} used.`,
  uploadFont: "Upload font",
  recognised: (page: number) => `Text found on page ${page}. Tap a line to edit it.`,
  recognisedMany: (pages: number) => `Text found on ${pages} pages. Tap a line to edit it.`,
  recognisedNone: "No text was found. Try choosing the language.",
  joined: (n: number) => `Joined ${n} files in the order chosen.`,
  lineDeleted: "Text deleted",
  undo: "Undo",
  updated: "Text updated",
  undone: "Undone",
  redone: "Redone",
  changed: "Page updated",
} as const;

export const HINT = {
  form: "This PDF has a form.",
  fill: "Fill it",
} as const;

export const INSTALL = {
  action: "Install app",
  offer: "Install PDFEdit to open it from your home screen, even offline.",
  later: "Not now",
  ios: "In Safari, tap Share, then Add to Home Screen.",
} as const;

export const KEYS = {
  title: "Keyboard shortcuts",
  open: "Keyboard shortcuts",
  singleKeys: "Single-letter tool keys",
  singleKeysHint: "Turn off if they get in the way of speech input.",
  tools: "Tools",
  general: "Document",
  rows: [
    ["Open a file", "Ctrl+O"],
    ["Download", "Ctrl+S"],
    ["Find and replace", "Ctrl+F"],
    ["Undo", "Ctrl+Z"],
    ["Redo", "Ctrl+Y"],
    ["Zoom in or out", "Ctrl and +, Ctrl and -"],
    ["Fit to width", "Ctrl+0"],
    ["Show or hide page thumbnails", "B"],
    ["Delete the selected item", "Delete"],
    ["Close a panel or cancel", "Escape"],
    ["Show this list", "?"],
  ],
} as const;

/** "ABCDEF+TimesNewRomanPS-BoldItalicMT" as people would say it */
export function fontName(family: string): string {
  return (
    family
      .replace(/^[A-Z]{6}\+/, "")
      .replace(/[,-](Bold|Italic|Regular|Oblique|Medium|Light|Roman|Semi|Black|Book).*$/i, "")
      .replace(/(PS)?MT$/, "")
      .replace(/PS$/, "")
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .trim() || "Unnamed font"
  );
}

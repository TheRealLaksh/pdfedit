import * as mupdf from "mupdf";
import { makePdf } from "./helpers";

/** two pages with every kind of field; one radio group spans both */
export function formPdf(needAppearances = false): Uint8Array {
  return makePdf([{ content: "" }, { content: "" }], (doc) => {
    const pages = [doc.findPage(0), doc.findPage(1)];
    const font = doc.addSimpleFont(new mupdf.Font("Helvetica"));
    const fields = doc.newArray();
    const annots = [doc.newArray(), doc.newArray()];
    const widget = (page: number, rect: number[], entries: Record<string, unknown>, parent?: mupdf.PDFObject) => {
      const w = doc.addObject({ Type: "Annot", Subtype: "Widget", Rect: rect, F: 4 });
      for (const [k, v] of Object.entries(entries)) w.put(k, v);
      w.put("P", pages[page]);
      annots[page]!.push(w);
      if (parent) {
        w.put("Parent", parent);
        parent.get("Kids").push(w);
      } else fields.push(w);
      return w;
    };
    const text = (t: string) => doc.newString(t);
    const da = text("/Helv 12 Tf 0 g");
    widget(0, [20, 340, 200, 365], { FT: "Tx", T: text("name"), TU: text("Full name"), DA: da });
    widget(0, [20, 260, 200, 320], { FT: "Tx", T: text("address"), DA: text("/Helv 0 Tf 0 0 1 rg"), Ff: 4096 });
    widget(0, [20, 225, 120, 245], { FT: "Tx", T: text("pin"), DA: da, Ff: 1 << 24, MaxLen: 6, MK: { BC: [0] } });
    widget(0, [20, 195, 35, 210], { FT: "Btn", T: text("agree"), MK: { BC: [0] } });
    const radio = doc.addObject({ FT: "Btn", Ff: (1 << 15) | (1 << 14), Kids: [] });
    radio.put("T", text("size"));
    fields.push(radio);
    const states = (name: string) => {
      const ap = doc.newDictionary();
      for (const [state, ops] of [[name, "0 g 3 3 9 9 re f 0 G 0 0 15 15 re S"], ["Off", "0 G 0 0 15 15 re S"]] as const)
        ap.put(state, doc.addStream(ops, { Type: "XObject", Subtype: "Form", BBox: [0, 0, 15, 15] }));
      return { N: ap };
    };
    widget(0, [20, 165, 35, 180], { AP: states("small"), AS: "Off" }, radio);
    widget(1, [20, 165, 35, 180], { AP: states("large"), AS: "Off" }, radio);
    widget(0, [20, 125, 160, 145], { FT: "Ch", Ff: 1 << 17, T: text("city"), DA: da, Opt: [[text("DEL"), text("Delhi")], [text("BOM"), text("मुंबई")]] });
    widget(0, [20, 60, 160, 110], { FT: "Ch", T: text("colour"), DA: da, Opt: [text("Red"), text("Green"), text("Blue")] });
    widget(1, [20, 340, 200, 365], { FT: "Tx", T: text("locked"), DA: da, Ff: 1, V: text("fixed") });
    widget(1, [20, 280, 200, 320], { FT: "Sig", T: text("sign") });
    pages[0]!.put("Annots", annots[0]);
    pages[1]!.put("Annots", annots[1]);
    const form = doc.addObject({ Fields: fields, DR: { Font: { Helv: font } } });
    if (needAppearances) form.put("NeedAppearances", true);
    doc.getTrailer().get("Root").put("AcroForm", form);
  });
}

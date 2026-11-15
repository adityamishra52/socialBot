// The open fonts embedded in book PDFs (see exportPdf.js PDF_FONTS). Vite bundles each file as an
// asset; they are fetched only when someone makes a PDF.

import tinos_r from "@expo-google-fonts/tinos/400Regular/Tinos_400Regular.ttf?url";
import tinos_i from "@expo-google-fonts/tinos/400Regular_Italic/Tinos_400Regular_Italic.ttf?url";
import tinos_b from "@expo-google-fonts/tinos/700Bold/Tinos_700Bold.ttf?url";
import tinos_bi from "@expo-google-fonts/tinos/700Bold_Italic/Tinos_700Bold_Italic.ttf?url";
import gelasio_r from "@expo-google-fonts/gelasio/400Regular/Gelasio_400Regular.ttf?url";
import gelasio_i from "@expo-google-fonts/gelasio/400Regular_Italic/Gelasio_400Regular_Italic.ttf?url";
import gelasio_b from "@expo-google-fonts/gelasio/700Bold/Gelasio_700Bold.ttf?url";
import gelasio_bi from "@expo-google-fonts/gelasio/700Bold_Italic/Gelasio_700Bold_Italic.ttf?url";
import eb_garamond_r from "@expo-google-fonts/eb-garamond/400Regular/EBGaramond_400Regular.ttf?url";
import eb_garamond_i from "@expo-google-fonts/eb-garamond/400Regular_Italic/EBGaramond_400Regular_Italic.ttf?url";
import eb_garamond_b from "@expo-google-fonts/eb-garamond/700Bold/EBGaramond_700Bold.ttf?url";
import eb_garamond_bi from "@expo-google-fonts/eb-garamond/700Bold_Italic/EBGaramond_700Bold_Italic.ttf?url";
import caladea_r from "@expo-google-fonts/caladea/400Regular/Caladea_400Regular.ttf?url";
import caladea_i from "@expo-google-fonts/caladea/400Regular_Italic/Caladea_400Regular_Italic.ttf?url";
import caladea_b from "@expo-google-fonts/caladea/700Bold/Caladea_700Bold.ttf?url";
import caladea_bi from "@expo-google-fonts/caladea/700Bold_Italic/Caladea_700Bold_Italic.ttf?url";
import source_serif_4_r from "@expo-google-fonts/source-serif-4/400Regular/SourceSerif4_400Regular.ttf?url";
import source_serif_4_i from "@expo-google-fonts/source-serif-4/400Regular_Italic/SourceSerif4_400Regular_Italic.ttf?url";
import source_serif_4_b from "@expo-google-fonts/source-serif-4/700Bold/SourceSerif4_700Bold.ttf?url";
import source_serif_4_bi from "@expo-google-fonts/source-serif-4/700Bold_Italic/SourceSerif4_700Bold_Italic.ttf?url";
import arimo_r from "@expo-google-fonts/arimo/400Regular/Arimo_400Regular.ttf?url";
import arimo_i from "@expo-google-fonts/arimo/400Regular_Italic/Arimo_400Regular_Italic.ttf?url";
import arimo_b from "@expo-google-fonts/arimo/700Bold/Arimo_700Bold.ttf?url";
import arimo_bi from "@expo-google-fonts/arimo/700Bold_Italic/Arimo_700Bold_Italic.ttf?url";

const FILES = {
  "tinos": { r: tinos_r, i: tinos_i, b: tinos_b, bi: tinos_bi },
  "gelasio": { r: gelasio_r, i: gelasio_i, b: gelasio_b, bi: gelasio_bi },
  "eb-garamond": { r: eb_garamond_r, i: eb_garamond_i, b: eb_garamond_b, bi: eb_garamond_bi },
  "caladea": { r: caladea_r, i: caladea_i, b: caladea_b, bi: caladea_bi },
  "source-serif-4": { r: source_serif_4_r, i: source_serif_4_i, b: source_serif_4_b, bi: source_serif_4_bi },
  "arimo": { r: arimo_r, i: arimo_i, b: arimo_b, bi: arimo_bi },
};

/** The TTF bytes { r, i, b, bi } of an embedded font family (Tinos if unknown). */
export async function loadPdfFonts(family) {
  const files = FILES[family] || FILES.tinos;
  const entries = await Promise.all(Object.entries(files).map(async ([key, url]) => {
    const response = await fetch(url);
    if (!response.ok) throw new Error("The book's font couldn't be loaded.");
    return [key, new Uint8Array(await response.arrayBuffer())];
  }));
  return Object.fromEntries(entries);
}

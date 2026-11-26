/**
 * Altezza della pagina /gex quando e' aperta da sola: GexPage usa h-full (dentro /market la
 * riceve dal riquadro del tab GEX), quindi senza questo contenitore restava alta quanto i
 * controlli e sotto si vedeva lo sfondo bianco (26/11/2026).
 */
export default function GexLayout({ children }: { children: React.ReactNode }) {
  return <div className="h-[calc(100vh-var(--barra-h))] bg-[#0c0d10]">{children}</div>;
}

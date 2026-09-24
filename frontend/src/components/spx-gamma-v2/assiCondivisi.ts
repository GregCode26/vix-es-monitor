/**
 * Margini orizzontali condivisi dai riquadri impilati sull'asse dei tempi.
 *
 * PriceChart e VolflowChartPanel stanno uno sopra l'altro e devono avere la
 * stessa x per lo stesso istante. Avevano invece rightMargin 140 e 20: il
 * grafico dei prezzi riserva 140px alle etichette del prezzo sulla destra, il
 * pannello VOLFLOW solo 20, e la stessa candela finiva 120px piu' a destra
 * nel riquadro di sotto -- le ultime barre cadevano oltre la fine della linea
 * del prezzo.
 *
 * Stanno qui, e non duplicati nei due file, perche' e' proprio la copia che
 * si era disallineata.
 */
export const MARGINE_SINISTRO = 60;
export const MARGINE_DESTRO = 140;

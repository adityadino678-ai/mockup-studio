import { useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { printifyApi, ProxyError } from '../../lib/printify/api';
import { physicalSize } from '../../lib/printify/placement';
import type { ColourSide, PrintifyVariant } from '../../lib/printify/types';

interface Props {
  blueprintId: number;
  providerId: number;
  variants: PrintifyVariant[];
  loading: boolean;
}

/**
 * One-off classification of every colour on the blueprint into light or dark.
 *
 * Printify's catalog only gives colour *names*, never hex values, so there is
 * nothing reliable to compute lightness from. Showing the real garment is the
 * honest way to decide: "Bay" and "Granite" are not guessable.
 *
 * The swatches come from Printify's own generated mockup of a template product,
 * re-served through the proxy so the page does not hotlink them.
 */
export function ColourGroups({ blueprintId, providerId, variants, loading }: Props): JSX.Element {
  const config = useStore((s) => s.project?.printify);
  const setColourSide = useStore((s) => s.setColourSide);
  const toggleShortlist = useStore((s) => s.toggleShortlistColour);
  const setShortlist = useStore((s) => s.setShortlist);
  const patchPrintify = useStore((s) => s.patchPrintify);

  const [filter, setFilter] = useState('');
  const [swatches, setSwatches] = useState<Record<string, string>>({});
  const [swatchError, setSwatchError] = useState<string | null>(null);
  const [bulk, setBulk] = useState<'light' | 'dark' | null>(null);

  const colours = useMemo(() => {
    const set = new Map<string, PrintifyVariant>();
    for (const v of variants) {
      const colour = v.options.color;
      if (colour && !set.has(colour)) set.set(colour, v);
    }
    return [...set.entries()]
      .map(([name, variant]) => ({ name, variant }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [variants]);

  const key = String(blueprintId);
  const sides: Record<string, ColourSide> = config?.colourSides[key] ?? {};
  const shortlist = config?.shortlist ?? [];

  // Grab a real mockup per colour from whichever product we were told to copy.
  useEffect(() => {
    let cancelled = false;
    const productId = config?.templateProductId;
    const shopId = config?.shopId;
    if (!productId || !shopId || !colours.length) return;

    (async () => {
      try {
        const product = await printifyApi.product(shopId, productId);
        const found: Record<string, string> = {};
        for (const { name, variant } of colours) {
          const shot = product.images?.find((img) => img.variant_ids.includes(variant.id));
          if (shot) found[name] = printifyApi.imageUrl(shot.src);
        }
        if (!cancelled) {
          setSwatches(found);
          setSwatchError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setSwatchError(
            err instanceof ProxyError ? err.message : 'Could not load the colour swatches.',
          );
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // Re-runs only when the blueprint or the reference product changes.
  }, [blueprintId, providerId, config?.templateProductId, config?.shopId, colours.length]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const list = needle ? colours.filter((c) => c.name.toLowerCase().includes(needle)) : colours;
    return list;
  }, [colours, filter]);

  const unclassified = colours.filter((c) => !sides[c.name] || sides[c.name] === 'unset');

  if (loading) return <p className="muted">Loading variants…</p>;

  return (
    <div className="colours">
      <div className="colours__bar">
        <input
          className="colours__search"
          placeholder="Filter colours…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="muted">
          {colours.length} colours · {unclassified.length} still undecided
        </span>
      </div>

      {swatchError ? <p className="warn warn--soft">{swatchError}</p> : null}
      {!swatchError && Object.keys(swatches).length === 0 ? (
        <p className="muted muted--tight">
          Pick a reference product below to see the real garment for each colour. Names alone are
          not enough to tell dark from light.
        </p>
      ) : null}

      <div className="colours__grid">
        {visible.map(({ name, variant }) => {
          const side = sides[name] ?? 'unset';
          const on = shortlist.includes(name);
          const ph = variant.placeholders[0];
          return (
            <div key={name} className={`swatch swatch--${side}${on ? ' is-on' : ''}`}>
              <button
                className="swatch__pick"
                onClick={() => toggleShortlist(name)}
                title={on ? 'In the shortlist — click to remove' : 'Add to the shortlist'}
              >
                {swatches[name] ? (
                  <img src={swatches[name]} alt="" loading="lazy" draggable={false} />
                ) : (
                  <span className="swatch__placeholder">{name.slice(0, 2)}</span>
                )}
                <span className="swatch__tick">{on ? '✓' : '+'}</span>
              </button>

              <div className="swatch__meta">
                <span className="swatch__name" title={name}>
                  {name}
                </span>
                {ph ? (
                  <span className="swatch__dims">
                    {physicalSize(ph).widthIn.toFixed(1)}&prime;
                  </span>
                ) : null}
              </div>

              <div className="swatch__sides" role="group" aria-label={`Ink for ${name}`}>
                <button
                  className={side === 'dark' ? 'is-on' : ''}
                  onClick={() => setColourSide(blueprintId, name, 'dark')}
                  title="Light garment, dark ink"
                >
                  dark ink
                </button>
                <button
                  className={side === 'light' ? 'is-on' : ''}
                  onClick={() => setColourSide(blueprintId, name, 'light')}
                  title="Dark garment, white ink"
                >
                  white ink
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {visible.length === 0 ? <p className="muted">No colour matches “{filter}”.</p> : null}

      <div className="colours__actions">
        <div className="colours__bulk">
          <span className="muted">Mark everything still undecided as</span>
          <button
            className="btn btn--ghost"
            onClick={() => setBulk('dark')}
            disabled={unclassified.length === 0}
          >
            dark ink
          </button>
          <button
            className="btn btn--ghost"
            onClick={() => setBulk('light')}
            disabled={unclassified.length === 0}
          >
            white ink
          </button>
        </div>

        <div className="colours__bulk">
          <span className="muted">Shortlist ({shortlist.length})</span>
          <button
            className="btn btn--ghost"
            onClick={() => setShortlist(colours.map((c) => c.name))}
            disabled={colours.length === 0}
          >
            all
          </button>
          <button className="btn btn--ghost" onClick={() => setShortlist([])} disabled={!shortlist.length}>
            none
          </button>
          <button
            className="btn btn--ghost"
            onClick={() =>
              setShortlist(colours.filter((c) => sides[c.name] === 'dark').map((c) => c.name))
            }
            disabled={!colours.some((c) => sides[c.name] === 'dark')}
          >
            light garments
          </button>
          <button
            className="btn btn--ghost"
            onClick={() =>
              setShortlist(colours.filter((c) => sides[c.name] === 'light').map((c) => c.name))
            }
            disabled={!colours.some((c) => sides[c.name] === 'light')}
          >
            dark garments
          </button>
        </div>

        {bulk ? (
          <button
            className="btn btn--primary"
            onClick={() => {
              patchPrintify({
                colourSides: {
                  ...(config?.colourSides ?? {}),
                  [key]: {
                    ...sides,
                    ...Object.fromEntries(unclassified.map((c) => [c.name, bulk])),
                  },
                },
              });
              setBulk(null);
            }}
          >
            Apply “{bulk === 'dark' ? 'dark ink' : 'white ink'}” to {unclassified.length} colours
          </button>
        ) : null}
      </div>
    </div>
  );
}
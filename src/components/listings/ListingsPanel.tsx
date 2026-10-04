import { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../../store/store';
import { printifyApi, ProxyError } from '../../lib/printify/api';
import { DEFAULT_PRINTIFY_CONFIG } from '../../lib/db';
import type {
  PrintifyBlueprint,
  PrintifyProvider,
  PrintifyShop,
  PrintifyVariant,
} from '../../lib/printify/types';
import { ColourGroups } from './ColourGroups';
import { BatchReview } from './BatchReview';

type Step = 'connect' | 'product' | 'colours' | 'batch';

const STEPS: { id: Step; label: string }[] = [
  { id: 'connect', label: '1 Connect' },
  { id: 'product', label: '2 Product' },
  { id: 'colours', label: '3 Colours' },
  { id: 'batch', label: '4 Listings' },
];

/**
 * Printify listings, kept separate from the canvas editor: the designs, print
 * area and mockups you already have are untouched, and this panel only reads
 * them to build create-product payloads.
 */
export function ListingsPanel({ onClose }: { onClose: () => void }): JSX.Element {
  const project = useStore((s) => s.project)!;
  const patchPrintify = useStore((s) => s.patchPrintify);

  const [step, setStep] = useState<Step>('connect');
  const [health, setHealth] = useState<{ ok: boolean; configured: boolean } | null>(null);
  const [shops, setShops] = useState<PrintifyShop[]>([]);
  const [blueprints, setBlueprints] = useState<PrintifyBlueprint[]>([]);
  const [providers, setProviders] = useState<PrintifyProvider[]>([]);
  const [variants, setVariants] = useState<PrintifyVariant[]>([]);
  const [positions, setPositions] = useState<string[]>(['front']);
  const [referenceProducts, setReferenceProducts] = useState<
    { id: string; title: string }[]
  >([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cfg = project.printify ?? DEFAULT_PRINTIFY_CONFIG;

  /* ------------------------------------------------------------ connection */

  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const result = await printifyApi.health();
        setHealth({ ok: result.ok, configured: result.configured });
        if (result.shops) setShops(result.shops);
      } catch (err) {
        setError(err instanceof ProxyError ? err.message : 'Could not reach the Printify proxy.');
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  useEffect(() => {
    if (!health?.ok) return;
    (async () => {
      try {
        setBlueprints(await printifyApi.blueprints());
      } catch {
        /* shown later when the user picks one */
      }
    })();
  }, [health?.ok]);

  /* ------------------------------------------------------------- catalogue */

  useEffect(() => {
    if (!cfg.blueprintId) {
      setProviders([]);
      return;
    }
    (async () => {
      setLoading(true);
      setError(null);
      try {
        setProviders(await printifyApi.providers(cfg.blueprintId!));
      } catch (err) {
        setError(err instanceof ProxyError ? err.message : 'Could not load print providers.');
      } finally {
        setLoading(false);
      }
    })();
  }, [cfg.blueprintId]);

  useEffect(() => {
    if (!cfg.blueprintId || !cfg.printProviderId) {
      setVariants([]);
      setPositions([]);
      return;
    }
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await printifyApi.variants(cfg.blueprintId!, cfg.printProviderId!);
        setVariants(result.variants);
        const found = [...new Set(result.variants.flatMap((v) => v.placeholders.map((p) => p.position)))];
        setPositions(found);
      } catch (err) {
        setError(err instanceof ProxyError ? err.message : 'Could not load variants.');
      } finally {
        setLoading(false);
      }
    })();
  }, [cfg.blueprintId, cfg.printProviderId]);

  /* ------------------------------------- reference product for prices + swatches */

  const loadReferenceProducts = useCallback(async () => {
    if (!cfg.shopId) return;
    try {
      const list = await printifyApi.products(cfg.shopId);
      setReferenceProducts(list.map((p) => ({ id: p.id, title: p.title })));
    } catch {
      setReferenceProducts([]);
    }
  }, [cfg.shopId]);

  useEffect(() => {
    void loadReferenceProducts();
  }, [loadReferenceProducts]);

  const copyFromProduct = async (productId: string) => {
    if (!cfg.shopId) return;
    setLoading(true);
    try {
      const product = await printifyApi.product(cfg.shopId, productId);
      const enabled = product.variants.find((v) => v.is_enabled);
      const colours = [...new Set(product.variants.filter((v) => v.is_enabled).map((v) => v.title.split('/').pop()?.trim() ?? ''))]
        .filter(Boolean)
        .sort();
      patchPrintify({
        templateProductId: productId,
        price: enabled?.price ?? cfg.price,
        descriptionTemplate: product.description || cfg.descriptionTemplate,
        safetyTemplate: product.safety_information ?? cfg.safetyTemplate,
        // The reference product's enabled variants are the colours actually
        // selling today, which is a far better starting shortlist than a guess.
        shortlist: colours.length ? colours : cfg.shortlist,
      });
      notify(`Copied price, description and ${colours.length} colours from “${product.title}”`);
    } catch (err) {
      setError(err instanceof ProxyError ? err.message : 'Could not read that product.');
    } finally {
      setLoading(false);
    }
  };

  function notify(message: string): void {
    useStore.getState().notify(message);
  }

  const blueprint = useMemo(
    () => blueprints.find((b) => b.id === cfg.blueprintId) ?? null,
    [blueprints, cfg.blueprintId],
  );
  const shop = useMemo(() => shops.find((s) => s.id === cfg.shopId) ?? null, [shops, cfg.shopId]);

  const canReach = health?.ok === true && Boolean(cfg.shopId) && Boolean(cfg.blueprintId) && Boolean(cfg.printProviderId);

  return (
    <div className="listings">
      <header className="listings__head">
        <h2>Printify listings</h2>
        <button className="icon" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </header>

      <nav className="listings__steps">
        {STEPS.map((s) => (
          <button
            key={s.id}
            className={step === s.id ? 'is-active' : ''}
            onClick={() => setStep(s.id)}
          >
            {s.label}
          </button>
        ))}
      </nav>

      <div className="listings__body">
        {error ? <p className="warn">{error}</p> : null}

        {step === 'connect' ? (
          <>
            {loading && !health ? <p className="muted">Contacting the Printify proxy…</p> : null}

            {health && !health.configured ? (
              <div className="callout">
                <h4>No token yet</h4>
                <p>
                  Printify cannot be called from a web page, so the app talks to a small local proxy
                  that holds your token.
                </p>
                <ol className="callout__steps">
                  <li>
                    Copy <code>.env.example</code> to <code>.env</code> in the project folder.
                  </li>
                  <li>
                    In Printify, open <strong>Connections</strong>, add a developer contact email,
                    press <strong>Generate</strong>, and name the token{' '}
                    <code>mockup-studio</code>.
                  </li>
                  <li>
                    Tick <code>shops.read</code> <code>catalog.read</code> <code>products.read</code>{' '}
                    <code>products.write</code> <code>uploads.read</code>{' '}
                    <code>uploads.write</code>, then generate.
                  </li>
                  <li>
                    Paste it into <code>.env</code> as <code>PRINTIFY_TOKEN=…</code> and restart{' '}
                    <code>npm run dev</code>. Copy the token straight away — Printify only shows it
                    once, and it expires after a year.
                  </li>
                </ol>
              </div>
            ) : null}

            {health?.ok ? (
              <>
                <label className="field field--wide">
                  <span>Shop</span>
                  <select
                    value={cfg.shopId ?? ''}
                    onChange={(e) =>
                      patchPrintify({ shopId: e.target.value ? Number(e.target.value) : null })
                    }
                  >
                    <option value="">Choose a shop…</option>
                    {shops.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title} — {s.sales_channel === 'disconnected' ? 'not connected' : s.sales_channel}
                      </option>
                    ))}
                  </select>
                  {shop?.sales_channel === 'disconnected' ? (
                    <em className="hint">
                      Nothing can go live from this shop, which makes it the safe place to try a
                      batch.
                    </em>
                  ) : null}
                </label>

                <label className="field field--wide">
                  <span>Copy settings from an existing product</span>
                  <select
                    value={cfg.templateProductId ?? ''}
                    onChange={(e) => {
                      const id = e.target.value || null;
                      patchPrintify({ templateProductId: id });
                      if (id) void copyFromProduct(id);
                    }}
                  >
                    <option value="">Start from scratch</option>
                    {referenceProducts.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                  <em className="hint">
                    Copies its price, description, safety text and the colours it has enabled.
                  </em>
                </label>
              </>
            ) : null}
          </>
        ) : null}

        {step === 'product' ? (
          <>
            <div className="grid2">
              <label className="field field--wide">
                <span>Blueprint (the blank product)</span>
                <select
                  value={cfg.blueprintId ?? ''}
                  onChange={(e) =>
                    patchPrintify({
                      blueprintId: e.target.value ? Number(e.target.value) : null,
                      printProviderId: null,
                    })
                  }
                >
                  <option value="">Choose a blueprint…</option>
                  {blueprints.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.title}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field field--wide">
                <span>Print provider</span>
                <select
                  value={cfg.printProviderId ?? ''}
                  disabled={!cfg.blueprintId}
                  onChange={(e) =>
                    patchPrintify({ printProviderId: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  <option value="">Choose a provider…</option>
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title}
                    </option>
                  ))}
                </select>
                <em className="hint">
                  {blueprint ? `${blueprint.title} · ${variants.length} variants in stock` : ' '}
                </em>
              </label>
            </div>

            {positions.length ? (
              <p className="muted muted--tight">
                Available print positions: {positions.join(', ')}
              </p>
            ) : null}
          </>
        ) : null}

        {step === 'colours' ? (
          cfg.blueprintId ? (
            <ColourGroups
              blueprintId={cfg.blueprintId}
              providerId={cfg.printProviderId ?? 0}
              variants={variants}
              loading={loading}
            />
          ) : (
            <p className="warn">Choose a blueprint and provider first.</p>
          )
        ) : null}

        {step === 'batch' && canReach ? (
          <BatchReview
            variants={variants}
            positions={positions.length ? positions : ['front']}
            onDone={() => setStep('colours')}
          />
        ) : null}
        {step === 'batch' && !canReach ? (
          <p className="warn">Connect a shop, blueprint and provider before building listings.</p>
        ) : null}
      </div>
    </div>
  );
}
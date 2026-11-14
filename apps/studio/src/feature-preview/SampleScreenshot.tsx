import { cn, fontWeights } from '@corral/react/design-kit';
import { SAMPLE_BROWSER } from './fixture.ts';

// The browser QA preview's screenshot: the sample checkout page drawn with theme tokens. No image
// is loaded and no markup is parsed; the drawing is part of the fixture.

const error = SAMPLE_BROWSER.console.find((line) => line.level === 'error');
const strong = { fontVariationSettings: fontWeights.semibold };

/** The sample checkout page. A named image, or decoration beside its file name. */
export function SampleScreenshot({
  label,
  className,
}: {
  /** Omitted, the drawing is decorative. */
  label?: string;
  className?: string;
}) {
  const { width, height } = SAMPLE_BROWSER.screenshot;
  return (
    <svg
      viewBox={`0 0 ${width / 2} ${height / 2}`}
      className={cn('block h-auto w-full', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {label ? <title>{label}</title> : null}
      {/* Window */}
      <rect width="640" height="400" className="fill-card" />
      <rect width="640" height="28" className="fill-muted" />
      <circle cx="16" cy="14" r="4" className="fill-accent" />
      <circle cx="30" cy="14" r="4" className="fill-accent" />
      <circle cx="44" cy="14" r="4" className="fill-accent" />
      <rect x="64" y="6" width="320" height="16" rx="8" className="fill-background" />
      <text x="76" y="18" fontSize="10" className="fill-muted-foreground">
        {SAMPLE_BROWSER.url.replace(/^https:\/\//, '')}
      </text>
      {/* Page */}
      <text x="32" y="68" fontSize="20" style={strong} className="fill-foreground">
        Checkout
      </text>
      <rect x="32" y="88" width="360" height="56" rx="8" className="fill-none stroke-border" />
      <rect x="44" y="98" width="36" height="36" rx="6" className="fill-muted" />
      <text x="92" y="114" fontSize="12" className="fill-foreground">
        Canvas tote × 1
      </text>
      <text x="92" y="130" fontSize="11" className="fill-muted-foreground">
        Natural, one size
      </text>
      <text x="380" y="122" fontSize="12" textAnchor="end" className="fill-foreground">
        $19.95
      </text>
      <text x="32" y="176" fontSize="11" className="fill-muted-foreground">
        Coupon code
      </text>
      <rect
        x="32"
        y="184"
        width="240"
        height="32"
        rx="6"
        className="fill-background stroke-border"
      />
      <text x="44" y="204" fontSize="12" className="fill-foreground">
        SAVE10
      </text>
      <rect x="280" y="184" width="112" height="32" rx="6" className="fill-accent" />
      <text x="336" y="204" fontSize="12" textAnchor="middle" className="fill-foreground">
        Apply coupon
      </text>
      <line x1="32" y1="240" x2="392" y2="240" className="stroke-border" />
      <text x="32" y="266" fontSize="14" style={strong} className="fill-foreground">
        Total
      </text>
      <text
        x="392"
        y="266"
        fontSize="14"
        style={strong}
        textAnchor="end"
        className="fill-foreground"
      >
        $19.95
      </text>
      <rect x="32" y="284" width="360" height="36" rx="8" className="fill-foreground" />
      <text x="212" y="307" fontSize="13" textAnchor="middle" className="fill-background">
        Place order
      </text>
      {/* Order notes column */}
      <rect x="424" y="88" width="184" height="232" rx="8" className="fill-muted" />
      <rect x="440" y="106" width="96" height="8" rx="4" className="fill-accent" />
      <rect x="440" y="126" width="152" height="6" rx="3" className="fill-accent" />
      <rect x="440" y="142" width="128" height="6" rx="3" className="fill-accent" />
      <rect x="440" y="158" width="140" height="6" rx="3" className="fill-accent" />
      {/* The error overlay the console reported */}
      <rect
        x="32"
        y="340"
        width="576"
        height="40"
        rx="8"
        className="fill-background stroke-destructive"
      />
      <circle cx="52" cy="360" r="6" className="fill-destructive" />
      <text x="68" y="364" fontSize="11" className="fill-destructive">
        {error?.message}
      </text>
    </svg>
  );
}

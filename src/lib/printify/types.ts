/** Shapes returned by the Printify API, trimmed to what this app reads. */

export interface PrintifyShop {
  id: number;
  title: string;
  sales_channel: string;
}

export interface PrintifyBlueprint {
  id: number;
  title: string;
  brand: string | null;
  model: string | null;
  images?: string[];
}

export interface PrintifyProvider {
  id: number;
  title: string;
}

export interface PrintifyPlaceholder {
  position: string;
  decoration_method: string;
  width: number;
  height: number;
}

export interface PrintifyVariant {
  id: number;
  title: string;
  options: { color?: string; size?: string; [k: string]: string | undefined };
  placeholders: PrintifyPlaceholder[];
  decoration_methods: string[];
}

export interface PrintifyVariantsResponse {
  id: number;
  title: string;
  variants: PrintifyVariant[];
}

export interface PrintifyUpload {
  id: string;
  file_name: string;
  width: number;
  height: number;
  size: number;
  mime_type: string;
  preview_url: string;
}

/** One variant of an existing product, used to copy prices as a starting point. */
export interface PrintifyProductVariant {
  id: number;
  title: string;
  price: number;
  cost: number;
  sku: string;
  is_enabled: boolean;
  is_available: boolean;
}

export interface PrintifyProduct {
  id: string;
  title: string;
  description: string;
  blueprint_id: number;
  print_provider_id: number;
  variants: PrintifyProductVariant[];
  images?: { position: string; src: string; variant_ids: number[]; is_default: boolean }[];
  safety_information?: string;
}

/** The body Printify expects when creating a product. */
export interface PrintifyImagePlacement {
  id: string;
  x: number;
  y: number;
  scale: number;
  angle: number;
}

export interface PrintifyPlaceholderInput {
  position: string;
  images: PrintifyImagePlacement[];
}

export interface PrintifyPrintArea {
  variant_ids: number[];
  placeholders: PrintifyPlaceholderInput[];
}

export interface PrintifyCreateBody {
  title: string;
  description: string;
  blueprint_id: number;
  print_provider_id: number;
  variants: { id: number; price: number; is_enabled: boolean }[];
  print_areas: PrintifyPrintArea[];
  tags?: string[];
  safety_information?: string;
}

export type InkGroup = 'light' | 'dark';

/** Which of the two inks each garment colour needs. */
export type ColourSide = InkGroup | 'unset';
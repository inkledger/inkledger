import { CATALOG_V1, PRODUCT_DEFAULTS_V1 } from "@contracts/workspace/catalogV1";

export function workspaceCatalogInventory(): unknown {
  return {
    catalog: CATALOG_V1,
    productDefaults: PRODUCT_DEFAULTS_V1,
  };
}

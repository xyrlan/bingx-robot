/**
 * Storage rules utilities — formatting and labels
 */

export const CONTAINER_TYPE_LABELS: Record<string, string> = {
  GP_20: '20\' GP',
  GP_40: '40\' GP',
  HC_40: '40\' HC',
  RF_20: '20\' RF',
  RF_40: '40\' RF',
};

export const SHIPMENT_TYPE_LABELS: Record<string, string> = {
  FCL: 'FCL',
  FCL_PARTIAL: 'FCL parcial',
  LCL: 'LCL',
};

export const FEE_BASIS_LABELS: Record<string, string> = {
  PER_BOX: 'Por caixa',
  PER_BL: 'Por BL',
  PER_WM: 'Por m³',
  PER_CONTAINER: 'Por container',
};

export function formatStorageFee(value: number, currency = 'BRL'): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function getFeeBasisLabel(basis: string): string {
  return FEE_BASIS_LABELS[basis] ?? basis;
}

export function getContainerTypeLabel(type: string | null | undefined): string {
  if (type == null || type === '') return '';
  return CONTAINER_TYPE_LABELS[type] ?? type;
}

export function getShipmentTypeLabel(type: string): string {
  return SHIPMENT_TYPE_LABELS[type] ?? type;
}

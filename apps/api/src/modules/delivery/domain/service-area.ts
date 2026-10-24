/**
 * A ServiceArea as the delivery module reads it: the platform's `config/service-areas/<CODE>.json`
 * (the marketplace's ServiceArea config), looked up by postcode.
 */
export interface ServiceArea {
  readonly code: string;
  readonly deliveryEnabled: boolean;
}

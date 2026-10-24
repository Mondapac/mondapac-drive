import au from '../../../config/markets/AU.json';
import zz from '../../../test/fixtures/markets/ZZ.json';
import { settingsOf } from './render';

/** Every rule is tested on the launch Market and on the synthetic ZZ Market. */
export const MARKETS = [settingsOf(au), settingsOf(zz)] as const;

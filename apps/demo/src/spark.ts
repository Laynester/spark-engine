// Single-file embed entry. `vite build --config vite.config.spark.ts` bundles
// the whole runtime + PixiJS into one public/spark.js, so a website can embed
// the movie with just one <script> and one <spark> tag:
//
//   <script src="/spark.js"></script>
//   <spark-player movie="./habbo.spark" sw1="external.variables.txt=/external_variables.txt"></spark-player>
import { defineSpark } from '@habbo/runtime';

defineSpark();

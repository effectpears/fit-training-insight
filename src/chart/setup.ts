import { Chart, registerables } from 'chart.js';
import annotationPlugin from 'chartjs-plugin-annotation';
import { CHART_FONT } from './chartConfig';

Chart.register(...registerables, annotationPlugin);
Chart.defaults.font.family = CHART_FONT;
Chart.defaults.color = '#cbd5e1';

export { Chart };

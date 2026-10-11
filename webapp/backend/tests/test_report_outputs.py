import unittest
from unittest.mock import patch

import numpy as np

import report_outputs


class ConcentrationStatsTests(unittest.TestCase):
    @patch('report_outputs._zone_raster', return_value=(None, {}))
    @patch('report_outputs._read_masked')
    @patch('report_outputs._monthly_conc_paths')
    def test_converts_raster_values_from_particles_per_m3_to_particles_per_litre(
            self, monthly_paths, read_masked, _zone_raster):
        monthly_paths.return_value = [(1, 'month-1.tif'), (2, 'month-2.tif')]
        read_masked.side_effect = [
            (np.array([[1000.0, 3000.0]]), None, None),
            (np.array([[3000.0, 5000.0]]), None, None),
        ]

        stats = report_outputs.compute_concentration_stats('case-study', 'scenario')

        self.assertEqual(stats['unit'], 'pathogens per litre')
        self.assertEqual(stats['mean'], 3.0)
        self.assertEqual(stats['median'], 3.0)
        self.assertEqual(stats['max'], 4.0)
        self.assertEqual(stats['monthly'][0]['value'], 2.0)
        self.assertEqual(stats['monthly'][1]['value'], 4.0)
        self.assertEqual(stats['peak_value'], 4.0)


if __name__ == '__main__':
    unittest.main()

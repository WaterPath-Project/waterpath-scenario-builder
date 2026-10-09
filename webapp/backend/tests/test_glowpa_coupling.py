import os
import csv
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from flask import Flask

import glowpa
import qmra
import state


class CoupledRunTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.output = self.root / 'output' / 'baseline'
        self.output.mkdir(parents=True)
        self.app = Flask(__name__)
        self.app.add_url_rule('/status/<run_id>', view_func=glowpa.run_status)
        self.client = self.app.test_client()
        self.run = {
            'status': 'running', 'kind': 'glowpa', 'cs_path': str(self.root),
            'folder': 'baseline', 'scenario_id': 'scenario', 'include_risk': False,
            'debug_mode': True,
        }
        self.runs = patch.dict(state.model_runs, {'test': self.run}, clear=True)
        self.runs.start()
        self.addCleanup(self.runs.stop)

    def test_launch_modes_share_coupling_implementation(self):
        exec_script = glowpa.build_r_expr_exec('study', 'baseline', 'baseline_config.yaml')
        run_script = glowpa.build_r_expr_run('baseline_config.yaml')
        self.assertIn("wp_run_model('config/baseline_config.yaml')", exec_script)
        self.assertIn("wp_run_model('/app/config/baseline_config.yaml')", run_script)
        for script in (exec_script, run_script):
            self.assertIn('wp_sum_to_grid <- function', script)
            self.assertIn('run$emissions$pathways$rast$land2water', script)

    def test_phases_keep_model_exclusivity(self):
        phase_path = self.output / '.glowpa_phase'
        for phase in ('coupling', 'hydrology_running'):
            with self.subTest(phase=phase):
                phase_path.write_text(phase, encoding='utf-8')
                self.assertEqual(self.client.get('/status/test').json['status'], phase)
                self.assertEqual(state.active_model_run()[0], 'test')
                self.assertEqual(self.run['status'], 'running')

    def test_missing_or_stale_phase_does_not_override_status(self):
        self.assertEqual(self.client.get('/status/test').json['status'], 'running')
        (self.output / '.glowpa_phase').write_text('coupling', encoding='utf-8')
        self.run['status'] = 'error'
        self.assertEqual(self.client.get('/status/test').json['status'], 'error')

    def test_risk_status_follows_hydrology(self):
        self.run.update(status='success', include_risk=True, risk_run_id='risk')
        state.model_runs['risk'] = {'status': 'running'}
        self.assertEqual(self.client.get('/status/test').json['status'], 'risk_running')
        state.model_runs['risk']['status'] = 'success'
        self.assertEqual(self.client.get('/status/test').json['status'], 'success')

    def test_coupling_failure_never_starts_risk(self):
        self.run['include_risk'] = True
        container = Mock()
        container.exec_run.return_value = Mock(
            exit_code=1,
            output=(b'Finished GloWPa simulation', b'load conservation failed'),
        )
        docker_client = Mock()
        docker_client.containers.get.return_value = container
        (self.output / '.glowpa_phase').write_text('coupling', encoding='utf-8')
        with patch.object(glowpa, '_get_docker_client', return_value=docker_client), \
                patch.object(qmra, '_trigger_qmra_run') as trigger:
            glowpa._execute_model_run('test', {
                'type': 'exec', 'container': 'glowpa-container', 'command': ['Rscript', 'run.R'],
            })
        self.assertEqual(self.run['status'], 'error')
        trigger.assert_not_called()
        self.assertFalse((self.output / '.glowpa_phase').exists())

    def test_coarse_population_requires_successful_coupling(self):
        fine = self.root / 'input' / 'baseline' / 'human_emissions'
        coarse = self.output / 'hydrology' / 'coupling'
        fine.mkdir(parents=True)
        coarse.mkdir(parents=True)
        for directory in (fine, coarse):
            for name in ('poprural.tif', 'popurban.tif'):
                (directory / name).touch()
        self.assertEqual(qmra._pop_rasters(str(self.root), 'baseline')[0],
                         os.fspath(fine / 'poprural.tif'))
        (coarse / 'complete.json').write_text('{}', encoding='utf-8')
        self.assertEqual(qmra._pop_rasters(str(self.root), 'baseline')[0],
                         os.fspath(coarse / 'poprural.tif'))

    def test_single_route_combined_band_uses_configured_variant(self):
        descriptions = (
            'drinking_untreated_monthly_q0.025',
            'drinking_untreated_monthly_q0.5',
            'drinking_untreated_monthly_q0.975',
            'drinking_treated_monthly_q0.025',
            'drinking_treated_monthly_q0.5',
            'drinking_treated_monthly_q0.975',
        )
        self.assertEqual(qmra._combined_source_route(descriptions), 'drinking')
        self.assertEqual(qmra._select_band_index(descriptions, 'combined', 0.5), 5)
        self.assertEqual(qmra._select_band_index(descriptions, 'drinking', 0.5), 5)

    def test_multi_route_combined_requires_explicit_combined_band(self):
        descriptions = (
            'drinking_untreated_monthly_q0.5',
            'swimming_untreated_monthly_q0.5',
        )
        self.assertIsNone(qmra._combined_source_route(descriptions))
        self.assertIsNone(qmra._select_band_index(descriptions, 'combined', 0.5))

    def test_area_cases_use_each_polygons_fine_population(self):
        import fiona
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin

        population_dir = self.root / 'input' / 'baseline' / 'human_emissions'
        risk_dir = self.output / 'qmra' / 'combined' / 'monthly'
        population_dir.mkdir(parents=True)
        risk_dir.mkdir(parents=True)

        fine_transform = from_origin(0, 1, 1, 1)
        for name, values in (
            ('poprural.tif', np.array([[100, 200, 300, 400]], dtype='float32')),
            ('popurban.tif', np.zeros((1, 4), dtype='float32')),
            ('isoraster.tif', np.array([[1, 2, 3, 4]], dtype='float32')),
        ):
            with rasterio.open(
                population_dir / name, 'w', driver='GTiff', width=4, height=1,
                count=1, dtype='float32', crs='EPSG:4326',
                transform=fine_transform, nodata=np.nan,
            ) as dst:
                dst.write(values, 1)
        with open(population_dir / 'isodata.csv', 'w', newline='', encoding='utf-8') as target:
            writer = csv.DictWriter(target, fieldnames=['iso', 'population'])
            writer.writeheader()
            for index, population in enumerate((90, 180, 270, 360), start=1):
                writer.writerow({'iso': index, 'population': population})

        risk_path = risk_dir / 'annual_risk.tif'
        with rasterio.open(
            risk_path, 'w', driver='GTiff', width=1, height=1, count=1,
            dtype='float32', crs='EPSG:4326', transform=from_origin(0, 1, 4, 1),
            nodata=np.nan,
        ) as dst:
            dst.write(np.array([[0.5]], dtype='float32'), 1)
            dst.set_band_description(1, 'drinking_treated_monthly_q0.5')

        shape_path = self.root / 'areas.shp'
        schema = {'geometry': 'Polygon', 'properties': {'name': 'str'}}
        with fiona.open(
            shape_path, 'w', driver='ESRI Shapefile', schema=schema,
            crs='EPSG:4326',
        ) as dst:
            for index in range(4):
                dst.write({
                    'geometry': {
                        'type': 'Polygon',
                        'coordinates': [[
                            (index, 0), (index + 1, 0), (index + 1, 1),
                            (index, 1), (index, 0),
                        ]],
                    },
                    'properties': {'name': f'Area {index + 1}'},
                })

        with patch.object(qmra, 'find_geodata_shapefile', return_value=str(shape_path)):
            result = qmra.compute_qmra_area_stats(
                {'folder_path': str(self.root)}, 'baseline',
            )

        self.assertEqual(set(result), {'1', '2', '3', '4'})
        for index, population in enumerate((90, 180, 270, 360), start=1):
            self.assertAlmostEqual(result[str(index)]['population'], population)
            self.assertAlmostEqual(result[str(index)]['cases'], population * 0.5)
            self.assertAlmostEqual(result[str(index)]['risk'], 0.5)
            self.assertLessEqual(result[str(index)]['cases'],
                                 result[str(index)]['population'])

        summary = qmra.compute_qmra_summary(
            {'folder_path': str(self.root)}, 'baseline', include_monthly=False,
        )
        self.assertAlmostEqual(summary['population_weighted']['population'], 900)
        self.assertAlmostEqual(summary['population_weighted']['risk']['combined'], 0.5)
        self.assertAlmostEqual(summary['combined']['cases']['sum'], 450)


if __name__ == '__main__':
    unittest.main()

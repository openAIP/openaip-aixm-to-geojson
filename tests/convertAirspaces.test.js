const { AixmConverter } = require('../src/aixm-converter');

describe('test parsing complete airspace file to GeoJSON file', () => {
    test('convert AIXM airspace file to GeoJSON file without error', async () => {
        const inputFilepath = './tests/fixtures/aixm-airspace.xml';
        const outputGeojsonFilepath = './var/airspace.geojson';

        const converter = new AixmConverter({ fixGeometries: true, strictSchemaValidation: true });
        await converter.convertFromFile(inputFilepath, { type: 'airspace' });
        await converter.toGeojsonFile(outputGeojsonFilepath);

        expect(true).toEqual(true);
    });
});

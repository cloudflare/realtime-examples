import struct
import unittest
import csv
from pathlib import Path
from music_partition import require_music_partition


class PartitionTests(unittest.TestCase):
    def entry(self, size=0x1000000, address=0x410000):
        return struct.pack('<HBBII16sI', 0x50AA, 1, 0x40, address, size, b'music', 0)

    def test_only_the_installed_music_region_is_accepted(self):
        require_music_partition(self.entry() + b'\xff' * 32)
        for table in [b'', self.entry(0x400000), self.entry(address=0x10000), self.entry()*2]:
            with self.assertRaises(ValueError): require_music_partition(table)

    def test_host_allocation_agrees_with_the_firmware_partition_table(self):
        rows = csv.reader((Path(__file__).resolve().parents[1] / "firmware/partitions.csv").read_text().splitlines())
        music = next(row for row in rows if row[0].strip() == "music")
        require_music_partition(self.entry(size=int(music[4], 0), address=int(music[3], 0)))


if __name__ == '__main__':
    unittest.main()

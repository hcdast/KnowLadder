from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from pypdf import PdfReader
from pathlib import Path
base=Path(__file__).parent
output=base/'revision107-original-course.pdf'
if output.exists():
 raise RuntimeError('Refusing to overwrite existing PDF')
c=canvas.Canvas(str(output),pagesize=A4)
c.setTitle('KnowLadder original training sample')
c.setFont('Helvetica-Bold',20)
c.drawString(48,780,'KnowLadder Training Practice')
c.setFont('Helvetica',12)
for i,line in enumerate(['Original synthetic material for local acceptance.','Step 1: Clarify the learning objective.','Step 2: Practice with a concrete example.','Step 3: Explain the result and reflect.','No personal information or third party material.']):
 c.drawString(48,730-i*30,line)
c.showPage();c.save()
r=PdfReader(str(output))
assert len(r.pages)==1
assert 'Clarify the learning objective' in r.pages[0].extract_text()
print({'pages':len(r.pages),'bytes':output.stat().st_size})
